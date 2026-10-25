import { createHash, randomUUID } from "node:crypto";
import type { Catalog } from "../../../packages/company-config/src/catalog";
import {
  type InvalidateRequest,
  InvalidateRequestSchema,
  type InvalidateResponse,
  InvalidateResponseSchema,
  type MemoryProposalRequest,
  MemoryProposalRequestSchema,
  type RememberRequest,
  RememberRequestSchema,
  type WriteResult,
  WriteResultSchema,
} from "../../../packages/contracts/src/memory";
import { cancelReindex } from "./admin-state";
import { canonicalize } from "./canonicalize";
import type { EmbeddingProvider } from "./embeddings";
import { MemoryServiceError } from "./errors";
import { type Principal, PrincipalError } from "./principal";
import { decodeMemoryRecord } from "./record-mapping";
import type { MemoryRepository, MemoryTransaction } from "./repository";
import { authorizeWrite, confirmProposal, MemoryPolicyError, validateWake } from "./scopes";

export { MemoryServiceError } from "./errors";

type ScanResult = { findings: Array<{ ruleId: string }>; count: number };

export type PreparedCanonicalFact = {
  id: string;
  scope: RememberRequest["scope"];
  kind: RememberRequest["kind"];
  title: string;
  content: string;
  confidence: RememberRequest["confidence"];
  wake: boolean;
  reviewAfter?: string;
  provenance: RememberRequest["provenance"];
  identityKey: string;
  canonicalKey: string;
  contentHash: string;
  embedding: number[];
};

export type CanonicalWriteMode = "remember" | "proposal" | "publication";

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function scopeKey(scope: RememberRequest["scope"]): string {
  return scope.kind === "org" ? "org" : `${scope.kind}:${scope.name}`;
}

function confidenceNumber(value: RememberRequest["confidence"]): number {
  return value === "high" ? 1 : value === "medium" ? 0.5 : 0;
}

function provenanceWithActor(items: RememberRequest["provenance"], username: string) {
  return items.map((item) => ({ ...item, actor: username }));
}

async function scan(scanner: { scanPersistedDTO(value: unknown): Promise<ScanResult> }, value: unknown) {
  const result = await scanner.scanPersistedDTO(value);
  if (result.count > 0) throw new MemoryServiceError("secret_rejected", 422);
}

async function loadCatalog(loader: () => Promise<Catalog>): Promise<Catalog> {
  try {
    return await loader();
  } catch {
    throw new MemoryServiceError("memory_unavailable", 503, true);
  }
}

function policyError(error: unknown): never {
  if (error instanceof PrincipalError) throw new MemoryServiceError("auth_invalid", 401);
  if (error instanceof MemoryPolicyError) {
    const code = error.code;
    const status = code === "domain_owner_required" || code === "org_owner_required" ? 403 : 400;
    throw new MemoryServiceError(code, status);
  }
  throw error;
}

function rememberRequestHash(input: RememberRequest): string {
  const { operationKey: _operationKey, ...requestBody } = input;
  return createHash("sha256")
    .update(canonicalJson({ operation: "remember", ...requestBody }), "utf8")
    .digest("hex");
}

function proposalRequestHash(input: MemoryProposalRequest): string {
  const { operationKey: _operationKey, ...proposalBody } = input;
  return createHash("sha256")
    .update(canonicalJson({ operation: "propose", ...proposalBody }), "utf8")
    .digest("hex");
}

function stateObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new MemoryServiceError("memory_unavailable", 503, true);
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new MemoryServiceError("memory_unavailable", 503, true);
  return value as Record<string, unknown>;
}

export function readOperations(state: Record<string, unknown>): Record<string, unknown> {
  const operations = state.operations;
  if (typeof operations !== "object" || operations === null || Array.isArray(operations))
    throw new MemoryServiceError("memory_unavailable", 503, true);
  const safe = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(operations)) safe[key] = (operations as Record<string, unknown>)[key];
  return safe;
}

export async function readOperationResult<T>(
  repository: MemoryRepository,
  key: string,
  requestHash: string,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): Promise<T | undefined> {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = await repository.query("SELECT worker_state FROM wagglebot_memory_schema_metadata");
  } catch {
    throw new MemoryServiceError("memory_unavailable", 503, true);
  }
  const row = rows[0];
  if (!row) throw new MemoryServiceError("memory_unavailable", 503, true);
  return replayResult(readOperations(stateObject(row.worker_state)), key, requestHash, schema);
}

export async function withMutationState<T>(
  repository: MemoryRepository,
  callback: (tx: MemoryTransaction, state: Record<string, unknown>) => Promise<T>,
) {
  return repository.withTransaction(async (tx) => {
    const row = (await tx.query("SELECT worker_state FROM wagglebot_memory_schema_metadata FOR UPDATE")).rows[0];
    if (!row) throw new MemoryServiceError("memory_unavailable", 503, true);
    const state = stateObject(row.worker_state);
    const result = await callback(tx, state);
    await persistState(tx, state);
    return result;
  });
}

async function persistState(tx: MemoryTransaction, state: Record<string, unknown>) {
  await tx.query("UPDATE wagglebot_memory_schema_metadata SET worker_state = $1::jsonb", [JSON.stringify(state)]);
}

export function actorKey(actor: "agent" | "human" | "git" | "operator", username: string, operationKey: string) {
  return JSON.stringify([actor, username, operationKey]);
}

export function replayResult<T>(
  operations: Record<string, unknown>,
  key: string,
  requestHash: string,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): T | undefined {
  const previous = Object.hasOwn(operations, key) ? operations[key] : undefined;
  if (previous === undefined) return undefined;
  if (typeof previous !== "object" || previous === null || Array.isArray(previous))
    throw new MemoryServiceError("memory_unavailable", 503, true);
  const record = previous as Record<string, unknown>;
  if (record.requestHash !== requestHash) throw new MemoryServiceError("operation_key_conflict", 409);
  const result = schema.safeParse(record.result);
  if (!result.success) throw new MemoryServiceError("memory_unavailable", 503, true);
  return result.data;
}

async function prepare(
  input: RememberRequest,
  principal: Principal,
  embeddingProvider: EmbeddingProvider,
): Promise<PreparedCanonicalFact> {
  const provenance = provenanceWithActor(input.provenance, principal.username);
  const keys = canonicalize({ scope: input.scope, kind: input.kind, title: input.title, content: input.content });
  const embedding = await embeddingProvider.embed(`${input.title}\n${input.content}`);
  if (embedding.length !== 384 || embedding.some((value) => !Number.isFinite(value)))
    throw new MemoryServiceError("memory_unavailable", 503, true);
  return {
    id: randomUUID(),
    scope: input.scope,
    kind: input.kind,
    title: input.title,
    content: input.content,
    confidence: input.confidence,
    wake: input.wake ?? false,
    ...(input.reviewAfter === undefined ? {} : { reviewAfter: input.reviewAfter }),
    provenance,
    ...keys,
    embedding,
  };
}

export async function writeCanonicalFact(
  tx: MemoryTransaction,
  fact: PreparedCanonicalFact,
  now: string,
  mode: CanonicalWriteMode,
): Promise<WriteResult["outcomes"][number]> {
  const existingRows = await tx.query("SELECT * FROM wagglebot_memories WHERE identity_key = $1 FOR UPDATE", [
    fact.identityKey,
  ]);
  const exact = existingRows.rows.find((row) => row.canonical_key === fact.canonicalKey);
  const active = existingRows.rows.find((row) => row.active === true);
  if (exact && mode === "proposal") {
    const existing = decodeMemoryRecord(exact);
    if (existing.status !== "active") return { recordId: existing.id, outcome: "unchanged" };
  }
  if (
    mode !== "publication" &&
    active &&
    active.canonical_key !== fact.canonicalKey &&
    confidenceNumber(fact.confidence) < Number(active.confidence)
  )
    throw new MemoryServiceError("lower_confidence_conflict", 409);

  if (exact) {
    const existing = decodeMemoryRecord(exact);
    const mergedProvenance = [...existing.provenance];
    for (const item of fact.provenance) {
      if (!mergedProvenance.some((candidate) => canonicalJson(candidate) === canonicalJson(item)))
        mergedProvenance.push(item);
    }
    const confidence =
      mode === "publication" || confidenceNumber(existing.confidence) < confidenceNumber(fact.confidence)
        ? fact.confidence
        : existing.confidence;
    const wake = mode === "proposal" ? existing.wake : fact.wake;
    const reviewAfter = mode === "proposal" ? existing.reviewAfter : fact.reviewAfter;
    if (existing.status === "active") {
      const changed =
        mode === "publication" ||
        confidence !== existing.confidence ||
        mergedProvenance.length !== existing.provenance.length ||
        wake !== existing.wake ||
        reviewAfter !== existing.reviewAfter;
      if (!changed) return { recordId: existing.id, outcome: "unchanged" };
      if (mode === "publication") {
        await tx.query(
          "UPDATE wagglebot_memories SET title = $2, kind = $3, confidence = $4, provenance = $5::jsonb, provenance_count = $6, wake = $7, review_after = $8, embedding = $9::vector, updated_at = $10 WHERE id = $1",
          [
            existing.id,
            fact.title,
            fact.kind,
            confidenceNumber(confidence),
            JSON.stringify(mergedProvenance),
            mergedProvenance.length,
            wake,
            reviewAfter ?? null,
            `[${fact.embedding.join(",")}]`,
            now,
          ],
        );
      } else {
        await tx.query(
          "UPDATE wagglebot_memories SET confidence = $2, provenance = $3::jsonb, provenance_count = $4, wake = $5, review_after = $6, updated_at = $7 WHERE id = $1",
          [
            existing.id,
            confidenceNumber(confidence),
            JSON.stringify(mergedProvenance),
            mergedProvenance.length,
            wake,
            reviewAfter ?? null,
            now,
          ],
        );
      }
      return { recordId: existing.id, outcome: "merged" };
    }
    if (active) {
      await tx.query(
        "UPDATE wagglebot_memories SET active = false, superseded_by = $2, updated_at = $3 WHERE id = $1",
        [active.id, existing.id, now],
      );
      await tx.query("UPDATE wagglebot_memories SET supersedes = $2 WHERE id = $1", [existing.id, active.id]);
    }
    const supersedes =
      active && active.id !== existing.id
        ? active.id
        : existing.supersedes !== existing.id
          ? existing.supersedes
          : undefined;
    if (mode === "publication") {
      await tx.query(
        "UPDATE wagglebot_memories SET active = true, invalidated_at = NULL, invalidation_reason = NULL, superseded_by = NULL, supersedes = $2, title = $3, kind = $4, confidence = $5, provenance = $6::jsonb, provenance_count = $7, wake = $8, review_after = $9, embedding = $10::vector, updated_at = $11 WHERE id = $1",
        [
          existing.id,
          supersedes ?? null,
          fact.title,
          fact.kind,
          confidenceNumber(confidence),
          JSON.stringify(mergedProvenance),
          mergedProvenance.length,
          wake,
          reviewAfter ?? null,
          `[${fact.embedding.join(",")}]`,
          now,
        ],
      );
    } else {
      await tx.query(
        "UPDATE wagglebot_memories SET active = true, invalidated_at = NULL, invalidation_reason = NULL, superseded_by = NULL, supersedes = $2, confidence = $3, provenance = $4::jsonb, provenance_count = $5, wake = $6, review_after = $7, updated_at = $8 WHERE id = $1",
        [
          existing.id,
          supersedes ?? null,
          confidenceNumber(confidence),
          JSON.stringify(mergedProvenance),
          mergedProvenance.length,
          wake,
          reviewAfter ?? null,
          now,
        ],
      );
    }
    return { recordId: existing.id, outcome: "superseded" };
  }

  if (active)
    await tx.query("UPDATE wagglebot_memories SET active = false, superseded_by = $2, updated_at = $3 WHERE id = $1", [
      active.id,
      fact.id,
      now,
    ]);
  await tx.query(
    `INSERT INTO wagglebot_memories
      (id, canonical_key, identity_key, kind, title, text, scopes, embedding, confidence, provenance, active,
       superseded_by, invalidated_at, invalidation_reason, content_hash, provenance_count, created_at, updated_at,
       wake, review_after, supersedes)
     VALUES ($1,$2,$3,$4,$5,$6,ARRAY[$7]::text[],$8::vector,$9,$10::jsonb,true,NULL,NULL,NULL,$11,$12,$13,$13,$14,$15,$16)`,
    [
      fact.id,
      fact.canonicalKey,
      fact.identityKey,
      fact.kind,
      fact.title,
      fact.content,
      scopeKey(fact.scope),
      `[${fact.embedding.join(",")}]`,
      confidenceNumber(fact.confidence),
      JSON.stringify(fact.provenance),
      fact.contentHash,
      fact.provenance.length,
      now,
      fact.wake,
      fact.reviewAfter ?? null,
      active?.id ?? null,
    ],
  );
  if (active) await tx.query("UPDATE wagglebot_memories SET supersedes = $2 WHERE id = $1", [fact.id, active.id]);
  return { recordId: fact.id, outcome: active ? "superseded" : "created" };
}

export function createWriteService(dependencies: {
  repository: MemoryRepository;
  loadCatalog: () => Promise<Catalog>;
  scanner: { scanPersistedDTO(value: unknown): Promise<ScanResult> };
  embeddingProvider: EmbeddingProvider;
  clock?: () => Date;
}) {
  const now = dependencies.clock ?? (() => new Date());

  async function mutate(input: RememberRequest, principal: Principal, actor: "agent" | "human"): Promise<WriteResult> {
    const prepared = await prepare(input, principal, dependencies.embeddingProvider);
    const requestHash = rememberRequestHash(input);
    const key = actorKey(actor, principal.username, input.operationKey);
    return withMutationState(dependencies.repository, async (tx, state) => {
      const currentCatalog = await loadCatalog(dependencies.loadCatalog);
      try {
        authorizeWrite(input.scope, principal, currentCatalog);
      } catch (error) {
        policyError(error);
      }
      const operations = readOperations(state);
      const replay = replayResult(operations, key, requestHash, WriteResultSchema);
      if (replay) return replay;
      const outcome = await writeCanonicalFact(tx, prepared, now().toISOString(), "remember");
      const result = WriteResultSchema.parse({
        schemaVersion: 1,
        operationKey: input.operationKey,
        outcomes: [outcome],
      });
      operations[key] = { requestHash, result };
      state.operations = operations;
      return result;
    });
  }

  return {
    async remember(raw: RememberRequest, principal: Principal): Promise<WriteResult> {
      let input: RememberRequest;
      try {
        input = RememberRequestSchema.parse(raw);
      } catch {
        throw new MemoryServiceError("memory_invalid", 400);
      }
      const catalog = await loadCatalog(dependencies.loadCatalog);
      try {
        authorizeWrite(input.scope, principal, catalog);
      } catch (error) {
        policyError(error);
      }
      const requestHash = rememberRequestHash(input);
      const key = actorKey("human", principal.username, input.operationKey);
      const replay = await readOperationResult(dependencies.repository, key, requestHash, WriteResultSchema);
      if (replay) return replay;
      try {
        validateWake(input, now());
      } catch (error) {
        policyError(error);
      }
      const fact = { ...input, provenance: provenanceWithActor(input.provenance, principal.username) };
      await scan(dependencies.scanner, fact);
      return mutate(input, principal, "human");
    },

    async propose(raw: MemoryProposalRequest, principal: Principal): Promise<WriteResult> {
      if (typeof raw === "object" && raw !== null && Array.isArray((raw as { facts?: unknown }).facts)) {
        for (const fact of (raw as { facts: unknown[] }).facts) {
          if (typeof fact !== "object" || fact === null || Array.isArray(fact)) continue;
          const item = fact as Record<string, unknown>;
          const scope = item.scope;
          if (
            typeof scope === "object" &&
            scope !== null &&
            !Array.isArray(scope) &&
            (scope as Record<string, unknown>).kind !== "system"
          ) {
            throw new MemoryServiceError("agent_scope_forbidden", 403);
          }
          if (item.wake === true) throw new MemoryServiceError("agent_wake_forbidden", 403);
        }
      }
      let input: MemoryProposalRequest;
      try {
        input = MemoryProposalRequestSchema.parse(raw);
      } catch {
        throw new MemoryServiceError("memory_invalid", 400);
      }
      const catalog = await loadCatalog(dependencies.loadCatalog);
      for (const fact of input.facts) {
        try {
          authorizeWrite(fact.scope, principal, catalog);
        } catch (error) {
          policyError(error);
        }
      }
      const requestHash = proposalRequestHash(input);
      const key = actorKey("agent", principal.username, input.operationKey);
      const replay = await readOperationResult(dependencies.repository, key, requestHash, WriteResultSchema);
      if (replay) return replay;
      for (const fact of input.facts) {
        try {
          confirmProposal(fact, principal, now());
        } catch (error) {
          policyError(error);
        }
      }
      const preparedFacts: PreparedCanonicalFact[] = [];
      for (const fact of input.facts) {
        const rememberFact: RememberRequest = {
          schemaVersion: 1,
          operationKey: input.operationKey,
          scope: fact.scope,
          kind: fact.kind,
          title: fact.title,
          content: fact.content,
          confidence: fact.confidence,
          wake: false,
          provenance: provenanceWithActor(fact.provenance, principal.username),
        };
        await scan(dependencies.scanner, rememberFact);
        preparedFacts.push(await prepare(rememberFact, principal, dependencies.embeddingProvider));
      }
      return withMutationState(dependencies.repository, async (tx, state) => {
        const currentCatalog = await loadCatalog(dependencies.loadCatalog);
        for (const fact of input.facts) {
          try {
            authorizeWrite(fact.scope, principal, currentCatalog);
          } catch (error) {
            policyError(error);
          }
        }
        const operations = readOperations(state);
        const replay = replayResult(operations, key, requestHash, WriteResultSchema);
        if (replay) return replay;
        for (const fact of input.facts) {
          try {
            confirmProposal(fact, principal, now());
          } catch (error) {
            policyError(error);
          }
        }
        const outcomes: WriteResult["outcomes"] = [];
        for (const fact of preparedFacts)
          outcomes.push(await writeCanonicalFact(tx, fact, now().toISOString(), "proposal"));
        const result = WriteResultSchema.parse({ schemaVersion: 1, operationKey: input.operationKey, outcomes });
        operations[key] = { requestHash, result };
        state.operations = operations;
        return result;
      });
    },

    async invalidate(id: string, raw: unknown, principal: Principal): Promise<InvalidateResponse> {
      let input: InvalidateRequest;
      try {
        input = InvalidateRequestSchema.parse(raw);
      } catch {
        throw new MemoryServiceError("memory_invalid", 400);
      }
      const catalog = await loadCatalog(dependencies.loadCatalog);
      if (!catalog.users.some((user) => user.name === principal.username))
        throw new MemoryServiceError("auth_invalid", 401);
      await scan(dependencies.scanner, { id, ...input, actor: principal.username });
      const { operationKey: _operationKey, ...invalidateBody } = input;
      const requestHash = createHash("sha256")
        .update(canonicalJson({ operation: "invalidate", id, ...invalidateBody }), "utf8")
        .digest("hex");
      const key = actorKey("human", principal.username, input.operationKey);
      return withMutationState(dependencies.repository, async (tx, state) => {
        const currentCatalog = await loadCatalog(dependencies.loadCatalog);
        if (!currentCatalog.users.some((user) => user.name === principal.username))
          throw new MemoryServiceError("auth_invalid", 401);
        const operations = readOperations(state);
        const rows = await tx.query("SELECT * FROM wagglebot_memories WHERE id = $1 FOR UPDATE", [id]);
        const row = rows.rows[0];
        if (!row) throw new MemoryServiceError("memory_not_found", 404);
        const record = decodeMemoryRecord(row);
        try {
          authorizeWrite(record.scope, principal, currentCatalog);
        } catch (error) {
          if (
            error instanceof MemoryPolicyError &&
            (error.code === "domain_owner_required" || error.code === "org_owner_required")
          ) {
            throw new MemoryServiceError("memory_forbidden", 403);
          }
          policyError(error);
        }
        const replay = replayResult(operations, key, requestHash, InvalidateResponseSchema);
        if (replay) return replay;
        if (record.status === "invalidated") {
          const response = InvalidateResponseSchema.parse({
            schemaVersion: 1,
            operationKey: input.operationKey,
            recordId: id,
            status: "invalidated",
          });
          operations[key] = { requestHash, result: response };
          state.operations = operations;
          return response;
        }
        await tx.query(
          "UPDATE wagglebot_memories SET active = false, invalidated_at = $2, invalidation_reason = $3, wake = false, updated_at = $2 WHERE id = $1",
          [id, now().toISOString(), input.reason],
        );
        state.reindex = cancelReindex(state, id).reindex;
        const response = InvalidateResponseSchema.parse({
          schemaVersion: 1,
          operationKey: input.operationKey,
          recordId: id,
          status: "invalidated",
        });
        operations[key] = { requestHash, result: response };
        state.operations = operations;
        return response;
      });
    },
  };
}
