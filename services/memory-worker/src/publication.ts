import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Catalog } from "../../../packages/company-config/src/catalog";
import { RelativePathSchema, type SharedScope } from "../../../packages/contracts/src/base";
import {
  type PublicationRequest,
  PublicationRequestSchema,
  PublicationResponseSchema,
} from "../../../packages/contracts/src/memory";
import { publicationIdentity, publicationKeys } from "../../../packages/knowledge/src/keys";
import { readSourceState as parseSourceState, type SourceState } from "../../../packages/memory-storage/src/state";
import { cancelReindex } from "./admin-state";
import type { EmbeddingProvider } from "./embeddings";
import { decodeMemoryRecord } from "./record-mapping";
import type { MemoryRepository } from "./repository";
import { validateSharedScope, validateWake } from "./scopes";
import {
  actorKey,
  canonicalJson,
  readOperationResult,
  readOperations,
  replayResult,
  withMutationState,
  writeCanonicalFact,
} from "./write-service";

const MAX_PUBLICATION_BODY_BYTES = 1_048_576;
const GIT_TIMEOUT_MS = 3_000;

export class PublicationServiceError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
    readonly retryable = false,
  ) {
    super(code);
    this.name = "PublicationServiceError";
  }
}

export type GitRevisionVerifier = {
  assertCommit(repository: string, revision: string): void;
  assertFastForward(repository: string, previous: string, next: string): void;
};

function fail(code: string, status = 400): never {
  throw new PublicationServiceError(code, status);
}

function exactCheckout(checkouts: Readonly<Record<string, string>>, repository: string): string {
  if (!Object.hasOwn(checkouts, repository)) fail("source_revision_regressed", 409);
  const checkout = checkouts[repository];
  if (typeof checkout !== "string" || !isAbsolute(checkout)) fail("memory_unavailable", 503);
  return checkout;
}

function runGit(checkout: string, args: string[]): string {
  try {
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name];
    return execFileSync("git", ["--no-optional-locks", "-C", checkout, ...args], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    }).trim();
  } catch {
    fail("source_revision_regressed", 409);
  }
}

function validRevision(revision: string): boolean {
  return /^[a-f0-9]{40}$/u.test(revision);
}

export function createGitRevisionVerifier(checkouts: Readonly<Record<string, string>>): GitRevisionVerifier {
  return {
    assertCommit(repository, revision) {
      if (!validRevision(revision)) fail("source_revision_regressed", 409);
      const checkout = exactCheckout(checkouts, repository);
      runGit(checkout, ["--no-replace-objects", "cat-file", "-e", `${revision}^{commit}`]);
    },
    assertFastForward(repository, previous, next) {
      if (!validRevision(previous) || !validRevision(next)) fail("source_revision_regressed", 409);
      const checkout = exactCheckout(checkouts, repository);
      runGit(checkout, ["--no-replace-objects", "merge-base", "--is-ancestor", previous, next]);
    },
  };
}

export function loadTrustedCheckouts(filePath: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    fail("memory_unavailable", 503);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) fail("memory_unavailable", 503);
  const checkouts = Object.create(null) as Record<string, string>;
  for (const [repository, configuredPath] of Object.entries(parsed)) {
    if (!repository || typeof configuredPath !== "string" || !isAbsolute(configuredPath))
      fail("memory_unavailable", 503);
    try {
      const checkout = realpathSync(configuredPath);
      if (!statSync(checkout).isDirectory()) fail("memory_unavailable", 503);
      checkouts[repository] = checkout;
    } catch {
      fail("memory_unavailable", 503);
    }
  }
  if (Object.keys(checkouts).length === 0) fail("memory_unavailable", 503);
  return checkouts;
}

export function scopeIdentity(scope: SharedScope): string {
  return scope.kind === "org" ? "org" : `${scope.kind}:${scope.name}`;
}

export function validatePublicationOwner(scopeValue: SharedScope, owner: string, catalog: Catalog): void {
  let scope: SharedScope;
  try {
    scope = validateSharedScope(scopeValue, catalog);
  } catch {
    fail("publication_invalid");
  }
  if (scope.kind === "org") {
    if (!catalog.users.some((user) => user.name === owner && user.orgOwner)) fail("publication_invalid");
    return;
  }
  const expectedOwner =
    scope.kind === "system"
      ? catalog.systems.find((item) => item.name === scope.name)?.owner
      : catalog.domains.find((item) => item.name === scope.name)?.owner;
  if (!expectedOwner || owner !== expectedOwner) fail("publication_invalid");
}

export type PreparedPublicationChunk = {
  id: string;
  chunkKey: string;
  heading: string;
  kind: PublicationRequest["chunks"][number]["kind"];
  title: string;
  content: string;
  confidence: PublicationRequest["chunks"][number]["confidence"];
  wake: boolean;
  reviewAfter?: string;
  identityKey: string;
  canonicalKey: string;
  contentHash: string;
  provenance: PublicationRequest["chunks"][number]["provenance"];
  embedding: number[];
};

export type PreparedPublication = {
  operationKey: string;
  sourceKey: string;
  repository: string;
  path: string;
  scope: SharedScope;
  owner: string;
  revision: string;
  bodyHash: string;
  requestHash: string;
  chunks: PreparedPublicationChunk[];
};

export function safeStateDictionary(value: unknown): Record<string, unknown> {
  const result = Object.create(null) as Record<string, unknown>;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    for (const key of Object.keys(value)) result[key] = (value as Record<string, unknown>)[key];
  }
  return result;
}

export function ownStateValue(dictionary: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(dictionary, key) ? dictionary[key] : undefined;
}

export function publicationChunkDictionary(
  chunks: readonly { chunkKey: string; recordId: string }[],
): Record<string, string> {
  const result = Object.create(null) as Record<string, string>;
  for (const chunk of chunks) result[chunk.chunkKey] = chunk.recordId;
  return result;
}

export function validateSourceBinding(
  previous: { repository: string; path: string; scope: SharedScope },
  next: Pick<PreparedPublication, "repository" | "path" | "scope">,
): void {
  if (
    previous.repository !== next.repository ||
    previous.path !== next.path ||
    scopeIdentity(previous.scope) !== scopeIdentity(next.scope)
  )
    fail("operation_key_conflict", 409);
}

type Scanner = { scanPersistedDTO(value: unknown): Promise<{ count: number }> };

function parsePublicationRequest(sourceKey: string, raw: unknown) {
  let serialized: string;
  try {
    serialized = JSON.stringify(raw);
  } catch {
    fail("publication_invalid");
  }
  if (typeof serialized !== "string") fail("publication_invalid");
  if (Buffer.byteLength(serialized, "utf8") > MAX_PUBLICATION_BODY_BYTES) fail("request_too_large", 413);
  const parsed = PublicationRequestSchema.safeParse(raw);
  if (!parsed.success) fail("publication_invalid");
  const request = parsed.data;
  const path = RelativePathSchema.safeParse(request.path);
  if (!path.success || typeof sourceKey !== "string" || sourceKey.length === 0) fail("publication_invalid");
  const requestHash = createHash("sha256")
    .update(
      canonicalJson({
        operation: "publish",
        sourceKey,
        ...Object.fromEntries(Object.entries(request).filter(([key]) => key !== "operationKey")),
      }),
      "utf8",
    )
    .digest("hex");
  return { request, path: path.data, requestHash };
}

export async function preparePublication(input: {
  sourceKey: string;
  raw: unknown;
  git: GitRevisionVerifier;
  loadCatalog: () => Promise<Catalog>;
  scanner: Scanner;
  embeddingProvider: EmbeddingProvider;
  clock?: () => Date;
}): Promise<PreparedPublication> {
  const { request, path, requestHash } = parsePublicationRequest(input.sourceKey, input.raw);
  input.git.assertCommit(request.repository, request.revision);

  let catalog: Catalog;
  try {
    catalog = await input.loadCatalog();
  } catch {
    throw new PublicationServiceError("memory_unavailable", 503, true);
  }
  validatePublicationOwner(request.scope, request.owner, catalog);
  const now = input.clock?.() ?? new Date();
  const seen = new Set<string>();
  const accepted: Omit<PreparedPublicationChunk, "embedding">[] = [];
  for (const chunk of request.chunks) {
    if (seen.has(chunk.chunkKey)) fail("publication_invalid");
    seen.add(chunk.chunkKey);
    try {
      validateWake(chunk, now);
    } catch {
      fail("publication_invalid");
    }
    const keyParts = publicationKeys(input.sourceKey, chunk.chunkKey, chunk.content);
    const provenance = [
      ...chunk.provenance.map((item) => ({ ...item, actor: request.owner })),
      {
        sourceType: "git" as const,
        actor: request.owner,
        repository: request.repository,
        path,
        commitSha: request.revision,
        heading: chunk.heading,
        sourceKey: input.sourceKey,
        capturedAt: now.toISOString(),
      },
    ];
    accepted.push({
      id: randomUUID(),
      chunkKey: chunk.chunkKey,
      heading: chunk.heading,
      kind: chunk.kind,
      title: chunk.title,
      content: chunk.content,
      confidence: chunk.confidence,
      wake: chunk.wake,
      ...(chunk.reviewAfter === undefined ? {} : { reviewAfter: chunk.reviewAfter }),
      ...keyParts,
      provenance,
    });
  }
  const sourceMaterial = {
    sourceKey: input.sourceKey,
    repository: request.repository,
    path,
    scope: request.scope,
    owner: request.owner,
    chunks: accepted.map(({ chunkKey, heading, kind, title, content, confidence, wake, reviewAfter }) => ({
      chunkKey,
      heading,
      kind,
      title,
      content,
      confidence,
      wake,
      reviewAfter,
    })),
  };
  const { operationKey: _operationKey, revision: _revision, ...canonicalBody } = request;
  const bodyHash = createHash("sha256")
    .update(canonicalJson({ sourceKey: input.sourceKey, ...canonicalBody }), "utf8")
    .digest("hex");
  let scanResult: { count: number };
  try {
    scanResult = await input.scanner.scanPersistedDTO({
      operationKey: request.operationKey,
      ...sourceMaterial,
      revision: request.revision,
      chunks: accepted,
    });
  } catch {
    throw new PublicationServiceError("scanner_unavailable", 503, true);
  }
  if (!Number.isSafeInteger(scanResult.count) || scanResult.count < 0)
    throw new PublicationServiceError("scanner_unavailable", 503, true);
  if (scanResult.count > 0) throw new PublicationServiceError("secret_rejected", 422);
  const prepared: PreparedPublicationChunk[] = [];
  for (const chunk of accepted) {
    let embedding: number[];
    try {
      embedding = await input.embeddingProvider.embed(`${chunk.title}\n${chunk.content}`);
    } catch {
      throw new PublicationServiceError("memory_unavailable", 503, true);
    }
    if (embedding.length !== 384 || embedding.some((value) => !Number.isFinite(value))) {
      throw new PublicationServiceError("memory_unavailable", 503, true);
    }
    prepared.push({ ...chunk, embedding });
  }
  return {
    operationKey: request.operationKey,
    sourceKey: input.sourceKey,
    repository: request.repository,
    path,
    scope: request.scope,
    owner: request.owner,
    revision: request.revision,
    bodyHash,
    requestHash,
    chunks: prepared,
  };
}

function readSourceState(value: unknown): SourceState {
  try {
    return parseSourceState(value);
  } catch {
    return fail("memory_unavailable", 503);
  }
}

export function createPublicationService(dependencies: {
  repository: MemoryRepository;
  git: GitRevisionVerifier;
  loadCatalog: () => Promise<Catalog>;
  scanner: Scanner;
  embeddingProvider: EmbeddingProvider;
  clock?: () => Date;
}) {
  const now = dependencies.clock ?? (() => new Date());

  return {
    async replaceSource(sourceKey: string, raw: unknown) {
      const parsed = parsePublicationRequest(sourceKey, raw);
      const key = actorKey("git", "configured-admin", parsed.request.operationKey);
      const replay = await readOperationResult(
        dependencies.repository,
        key,
        parsed.requestHash,
        PublicationResponseSchema,
      );
      if (replay) return replay;
      const prepared = await preparePublication({
        sourceKey,
        raw,
        git: dependencies.git,
        loadCatalog: dependencies.loadCatalog,
        scanner: dependencies.scanner,
        embeddingProvider: dependencies.embeddingProvider,
        clock: now,
      });
      return withMutationState(dependencies.repository, async (tx, state) => {
        const operations = readOperations(state);
        const replay = replayResult(operations, key, prepared.requestHash, PublicationResponseSchema);
        if (replay) return replay;

        let catalog: Catalog;
        try {
          catalog = await dependencies.loadCatalog();
        } catch {
          throw new PublicationServiceError("memory_unavailable", 503, true);
        }
        validatePublicationOwner(prepared.scope, prepared.owner, catalog);
        dependencies.git.assertCommit(prepared.repository, prepared.revision);

        if (typeof state.sources !== "object" || state.sources === null || Array.isArray(state.sources))
          fail("memory_unavailable", 503);
        const sources = safeStateDictionary(state.sources);
        const rawPrevious = ownStateValue(sources, prepared.sourceKey);
        const previous = rawPrevious === undefined ? undefined : readSourceState(rawPrevious);
        if (previous) {
          validateSourceBinding(previous, prepared);
          if (previous.currentRevision === prepared.revision) {
            if (previous.bodyHash !== prepared.bodyHash) fail("operation_key_conflict", 409);
            const result = PublicationResponseSchema.parse({
              schemaVersion: 1,
              operationKey: prepared.operationKey,
              sourceKey: prepared.sourceKey,
              revision: prepared.revision,
              created: 0,
              updated: 0,
              invalidated: 0,
              unchanged: prepared.chunks.length,
            });
            operations[key] = { requestHash: prepared.requestHash, result };
            state.operations = operations;
            return result;
          }
          if (previous.revisions.includes(prepared.revision)) fail("source_revision_regressed", 409);
          dependencies.git.assertFastForward(prepared.repository, previous.currentRevision, prepared.revision);
        }

        const acceptanceTime = now();
        for (const chunk of prepared.chunks) {
          try {
            validateWake(chunk, acceptanceTime);
          } catch {
            fail("publication_invalid");
          }
        }
        const currentChunks = publicationChunkDictionary([]);
        let created = 0;
        let updated = 0;
        let unchanged = 0;
        for (const chunk of prepared.chunks) {
          const outcome = await writeCanonicalFact(
            tx,
            {
              id: chunk.id,
              scope: prepared.scope,
              kind: chunk.kind,
              title: chunk.title,
              content: chunk.content,
              confidence: chunk.confidence,
              wake: chunk.wake,
              ...(chunk.reviewAfter === undefined ? {} : { reviewAfter: chunk.reviewAfter }),
              provenance: chunk.provenance,
              identityKey: chunk.identityKey,
              canonicalKey: chunk.canonicalKey,
              contentHash: chunk.contentHash,
              embedding: chunk.embedding,
            },
            acceptanceTime.toISOString(),
            "publication",
          );
          currentChunks[chunk.chunkKey] = outcome.recordId;
          if (outcome.outcome === "created") created += 1;
          else if (outcome.outcome === "unchanged") unchanged += 1;
          else updated += 1;
        }

        let invalidated = 0;
        if (previous) {
          for (const [chunkKey, id] of Object.entries(previous.chunks)) {
            if (Object.hasOwn(currentChunks, chunkKey)) continue;
            const result = await tx.query("SELECT * FROM wagglebot_memories WHERE id = $1 FOR UPDATE", [id]);
            const row = result.rows[0];
            if (!row) fail("memory_unavailable", 503);
            const record = decodeMemoryRecord(row);
            if (record.identityKey !== publicationIdentity(prepared.sourceKey, chunkKey))
              fail("memory_unavailable", 503);
            if (record.status === "invalidated") continue;
            await tx.query(
              "UPDATE wagglebot_memories SET active = false, invalidated_at = $2, invalidation_reason = $3, wake = false, updated_at = $2 WHERE id = $1",
              [id, acceptanceTime.toISOString(), "removed from reviewed source"],
            );
            state.reindex = cancelReindex(state, id).reindex;
            invalidated += 1;
          }
        }

        sources[prepared.sourceKey] = {
          repository: prepared.repository,
          path: prepared.path,
          scope: prepared.scope,
          owner: prepared.owner,
          currentRevision: prepared.revision,
          bodyHash: prepared.bodyHash,
          revisions: previous ? [...previous.revisions, prepared.revision] : [prepared.revision],
          chunks: currentChunks,
        } satisfies SourceState;
        state.sources = sources;
        const result = PublicationResponseSchema.parse({
          schemaVersion: 1,
          operationKey: prepared.operationKey,
          sourceKey: prepared.sourceKey,
          revision: prepared.revision,
          created,
          updated,
          invalidated,
          unchanged,
        });
        operations[key] = { requestHash: prepared.requestHash, result };
        state.operations = operations;
        return result;
      });
    },
  };
}
