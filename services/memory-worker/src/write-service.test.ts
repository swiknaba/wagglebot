import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { MemoryProposalRequest, WriteResult } from "../../../packages/contracts/src/memory";
import { enqueueReindex, readAdminState, startRun } from "./admin-state";
import { canonicalize } from "./canonicalize";
import { createWriteService } from "./write-service";

const principal = {
  username: "alice",
  issuedAt: new Date("2026-10-18T10:00:00.000Z"),
  expiresAt: new Date("2026-10-18T11:00:00.000Z"),
  tokenId: "token-1",
  groups: ["payments"],
  orgOwner: false,
};

const catalog = {
  users: [{ name: "alice", orgOwner: false }],
  groups: [{ name: "payments", members: ["alice"] }],
  systems: [{ name: "billing" }],
  domains: [{ name: "commerce", owner: "payments" }],
};

function dependencies(
  catalogValue = catalog,
  seededRows: Array<Record<string, unknown>> = [],
  overrides: {
    scanner?: { scanPersistedDTO(value: unknown): Promise<{ findings: Array<{ ruleId: string }>; count: number }> };
    embeddingProvider?: { embed(value: string): Promise<number[]> };
    initialState?: unknown;
    loadCatalog?: () => Promise<unknown>;
    clock?: () => Date;
  } = {},
) {
  const statements: Array<{ sql: string; values?: unknown[] }> = [];
  let state: unknown = overrides.initialState ?? { operations: {} };
  let rows = structuredClone(seededRows);
  const repository = {
    query: async (sql: string) =>
      sql.includes("SELECT worker_state FROM wagglebot_memory_schema_metadata") ? [{ worker_state: state }] : [],
    assertReady: async () => undefined,
    withTransaction: async <T>(callback: (transaction: { query: typeof transactionQuery }) => Promise<T>) => {
      const originalState = structuredClone(state);
      const originalRows = structuredClone(rows);
      try {
        return await callback({ query: transactionQuery });
      } catch (error) {
        state = originalState;
        rows = originalRows;
        throw error;
      }
    },
    close: async () => undefined,
  };
  async function transactionQuery(sql: string, values?: unknown[]) {
    statements.push({ sql, values });
    if (sql.includes("SELECT worker_state")) return { rows: [{ worker_state: state }] };
    if (sql.includes("UPDATE wagglebot_memory_schema_metadata")) state = JSON.parse(String(values?.[0]));
    if (sql.includes("SELECT * FROM wagglebot_memories WHERE identity_key"))
      return { rows: rows.filter((row) => row.identity_key === values?.[0]) };
    if (sql.includes("SELECT * FROM wagglebot_memories WHERE id"))
      return { rows: rows.filter((row) => row.id === values?.[0]) };
    if (sql.includes("INSERT INTO wagglebot_memories")) {
      rows.push({
        id: values?.[0],
        canonical_key: values?.[1],
        identity_key: values?.[2],
        kind: values?.[3],
        title: values?.[4],
        text: values?.[5],
        scopes: [values?.[6]],
        confidence: values?.[8],
        provenance: JSON.parse(String(values?.[9])),
        active: true,
        superseded_by: null,
        invalidated_at: null,
        invalidation_reason: null,
        content_hash: values?.[10],
        provenance_count: values?.[11],
        created_at: values?.[12],
        updated_at: values?.[12],
        wake: values?.[13],
        review_after: values?.[14],
        supersedes: values?.[15],
      });
    }
    if (sql.includes("SET active = false, superseded_by = $2")) {
      const row = rows.find((candidate) => candidate.id === values?.[0]);
      if (row) Object.assign(row, { active: false, superseded_by: values?.[1], updated_at: values?.[2] });
    }
    if (sql.includes("SET supersedes = $2 WHERE id = $1")) {
      const row = rows.find((candidate) => candidate.id === values?.[0]);
      if (row) row.supersedes = values?.[1];
    }
    if (sql.includes("SET confidence = $2, provenance = $3")) {
      const row = rows.find((candidate) => candidate.id === values?.[0]);
      if (row)
        Object.assign(row, {
          confidence: values?.[1],
          provenance: JSON.parse(String(values?.[2])),
          provenance_count: values?.[3],
          wake: values?.[4],
          review_after: values?.[5],
          updated_at: values?.[6],
        });
    }
    if (sql.includes("SET active = true, invalidated_at = NULL")) {
      const row = rows.find((candidate) => candidate.id === values?.[0]);
      if (row)
        Object.assign(row, {
          active: true,
          invalidated_at: null,
          invalidation_reason: null,
          superseded_by: null,
          supersedes: values?.[1],
          confidence: values?.[2],
          provenance: JSON.parse(String(values?.[3])),
          provenance_count: values?.[4],
          wake: values?.[5],
          review_after: values?.[6],
          updated_at: values?.[7],
        });
    }
    if (sql.includes("SET active = false, invalidated_at = $2")) {
      const row = rows.find((candidate) => candidate.id === values?.[0]);
      if (row)
        Object.assign(row, {
          active: false,
          invalidated_at: values?.[1],
          invalidation_reason: values?.[2],
          wake: false,
          updated_at: values?.[1],
        });
    }
    return { rows: [] };
  }
  return {
    service: createWriteService({
      repository: repository as never,
      loadCatalog: (overrides.loadCatalog ?? (async () => catalogValue)) as never,
      scanner: overrides.scanner ?? { scanPersistedDTO: async () => ({ findings: [], count: 0 }) },
      embeddingProvider: overrides.embeddingProvider ?? { embed: async () => Array.from({ length: 384 }, () => 0.1) },
      clock: overrides.clock ?? (() => new Date("2026-10-18T10:30:00.000Z")),
    }),
    statements,
    rows: () => structuredClone(rows),
    state: () => structuredClone(state),
  };
}

function storedRow(
  title: string,
  content: string,
  options: {
    confidence?: number;
    wake?: boolean;
    active?: boolean;
    invalidatedAt?: string | null;
    supersededBy?: string | null;
    supersedes?: string | null;
  } = {},
) {
  const scope = { kind: "system" as const, name: "billing" };
  const keys = canonicalize({ scope, kind: "fact", title, content });
  const id = randomUUID();
  return {
    id,
    canonical_key: keys.canonicalKey,
    identity_key: keys.identityKey,
    kind: "fact",
    title,
    text: content,
    scopes: ["system:billing"],
    confidence: options.confidence ?? 1,
    provenance: [{ sourceType: "human", actor: "alice", capturedAt: "2026-10-18T10:20:00.000Z" }],
    active: options.active ?? true,
    superseded_by: options.supersededBy ?? null,
    invalidated_at: options.invalidatedAt ?? null,
    invalidation_reason: options.invalidatedAt ? "old reason" : null,
    content_hash: keys.contentHash,
    provenance_count: 1,
    created_at: "2026-10-18T10:20:00.000Z",
    updated_at: "2026-10-18T10:20:00.000Z",
    wake: options.wake ?? false,
    review_after: options.wake ? "2026-11-01" : null,
    supersedes: options.supersedes ?? null,
  };
}

const remember = {
  schemaVersion: 1 as const,
  operationKey: "remember-1",
  scope: { kind: "system" as const, name: "billing" },
  kind: "fact" as const,
  title: "  Renewal   window ",
  content: "Renewal closes on Friday.",
  confidence: "high" as const,
  wake: false,
  provenance: [
    {
      sourceType: "human" as const,
      actor: "untrusted-request-actor",
      capturedAt: "2026-10-18T10:20:00.000Z",
    },
  ],
};

function proposalFact(
  overrides: Partial<Pick<MemoryProposalRequest["facts"][number], "title" | "content" | "confidence">> & {
    actor?: string;
    capturedAt?: string;
  } = {},
): MemoryProposalRequest["facts"][number] {
  return {
    scope: { kind: "system" as const, name: "billing" },
    kind: "fact" as const,
    title: overrides.title ?? remember.title,
    content: overrides.content ?? remember.content,
    confidence: overrides.confidence ?? remember.confidence,
    provenance: [
      {
        sourceType: "human",
        actor: overrides.actor ?? "untrusted-request-actor",
        capturedAt: overrides.capturedAt ?? "2026-10-18T10:20:00.000Z",
      },
    ],
    confirmedBy: "alice",
    confirmedAt: "2026-10-18T10:20:00.000Z",
  };
}

test("remember overwrites provenance actor with the verified principal and writes the operation ledger in one transaction", async () => {
  const { service, statements } = dependencies();
  const result = await service.remember(remember, principal);
  expect(result.schemaVersion).toBe(1);
  expect(result.outcomes).toHaveLength(1);
  const ledgerWrite = statements.find(({ sql }) => sql.includes("worker_state"));
  const memoryWrite = statements.find(({ sql }) => sql.includes("INSERT INTO wagglebot_memories"));
  expect(ledgerWrite).toBeDefined();
  expect(memoryWrite).toBeDefined();
  const persistedProvenance = JSON.parse(String(memoryWrite?.values?.[9]));
  expect(persistedProvenance[0].actor).toBe("alice");
});

test("domain ownership is checked before opening a mutation transaction", async () => {
  const { service, statements } = dependencies({
    ...catalog,
    groups: [{ name: "payments", members: [] }],
  });
  await expect(
    service.remember({ ...remember, scope: { kind: "domain", name: "commerce" } }, principal),
  ).rejects.toMatchObject({ code: "domain_owner_required" });
  expect(statements).toHaveLength(0);
});

test("replaying a canonical operation returns its original result without a second insert", async () => {
  const { service, statements } = dependencies();
  const first = await service.remember(remember, principal);
  const replay = await service.remember(remember, principal);
  expect(replay).toEqual(first);
  expect(statements.filter(({ sql }) => sql.includes("INSERT INTO wagglebot_memories"))).toHaveLength(1);
});

test("reusing an operation key with a different canonical body conflicts before a second write", async () => {
  const { service, statements } = dependencies();
  await service.remember(remember, principal);
  await expect(
    service.remember({ ...remember, content: "Renewal closes on Monday." }, principal),
  ).rejects.toMatchObject({
    code: "operation_key_conflict",
    status: 409,
  });
  expect(statements.filter(({ sql }) => sql.includes("INSERT INTO wagglebot_memories"))).toHaveLength(1);
});

test("current catalog authorization is rechecked before returning an idempotent replay", async () => {
  let loadCount = 0;
  const removedUserCatalog = { ...catalog, users: [] };
  const { service } = dependencies(catalog, [], {
    loadCatalog: async () => {
      loadCount += 1;
      return loadCount <= 2 ? catalog : removedUserCatalog;
    },
  });
  await service.remember(remember, principal);
  await expect(service.remember(remember, principal)).rejects.toMatchObject({ code: "auth_invalid", status: 401 });
});

test("remember replay survives an expired wake date without scanning, embedding, or opening a transaction", async () => {
  let currentTime = new Date("2026-10-18T10:30:00.000Z");
  let scans = 0;
  let embeddings = 0;
  const database = dependencies(catalog, [], {
    clock: () => currentTime,
    scanner: {
      scanPersistedDTO: async () => {
        scans += 1;
        return { findings: [], count: 0 };
      },
    },
    embeddingProvider: {
      embed: async () => {
        embeddings += 1;
        return Array(384).fill(0.1);
      },
    },
  });
  const request = { ...remember, wake: true, reviewAfter: "2026-10-19" };
  const first = await database.service.remember(request, principal);
  const statementCount = database.statements.length;
  currentTime = new Date("2026-10-20T10:30:00.000Z");
  const replay = await database.service.remember(request, principal);
  expect(replay).toEqual(first);
  expect(database.statements).toHaveLength(statementCount);
  expect(scans).toBe(1);
  expect(embeddings).toBe(1);
});

test("proposal replay survives renewal of the same user's session without repeating side effects", async () => {
  let scans = 0;
  let embeddings = 0;
  const database = dependencies(catalog, [], {
    scanner: {
      scanPersistedDTO: async () => {
        scans += 1;
        return { findings: [], count: 0 };
      },
    },
    embeddingProvider: {
      embed: async () => {
        embeddings += 1;
        return Array(384).fill(0.1);
      },
    },
  });
  const request = { schemaVersion: 1 as const, operationKey: "renewed-session", facts: [proposalFact()] };
  const first = await database.service.propose(request, principal);
  const statementCount = database.statements.length;
  const renewedPrincipal = {
    ...principal,
    issuedAt: new Date("2026-10-18T10:40:00.000Z"),
    expiresAt: new Date("2026-10-18T11:40:00.000Z"),
    tokenId: "token-renewed",
  };
  const replay = await database.service.propose(request, renewedPrincipal);
  expect(replay).toEqual(first);
  expect(database.statements).toHaveLength(statementCount);
  expect(scans).toBe(1);
  expect(embeddings).toBe(1);
});

test("proposal locked replay precedes confirmation expiry after an early lookup miss", async () => {
  let currentTime = new Date("2026-10-18T10:30:00.000Z");
  let nested = false;
  let nestedResult: WriteResult | undefined;
  let service: ReturnType<typeof dependencies>["service"];
  const request = { schemaVersion: 1 as const, operationKey: "concurrent-proposal", facts: [proposalFact()] };
  const database = dependencies(catalog, [], {
    clock: () => currentTime,
    embeddingProvider: {
      embed: async () => {
        if (!nested) {
          nested = true;
          nestedResult = await service.propose(request, principal);
          currentTime = new Date("2026-10-18T12:00:00.000Z");
        }
        return Array(384).fill(0.1);
      },
    },
  });
  service = database.service;
  const result = await service.propose(request, principal);
  if (!nestedResult) throw new Error("nested proposal must succeed before outer replay");
  expect(result).toEqual(nestedResult);
  expect(database.rows()).toHaveLength(1);
});

test("proposal scope and wake violations keep specific authorization codes before generic parsing", async () => {
  const { service, statements } = dependencies();
  const base = {
    schemaVersion: 1,
    operationKey: "proposal-1",
    facts: [
      {
        ...remember,
        scope: { kind: "domain", name: "commerce" },
        confirmedBy: "alice",
        confirmedAt: "2026-10-18T10:20:00.000Z",
      },
    ],
  };
  await expect(service.propose(base as never, principal)).rejects.toMatchObject({
    code: "agent_scope_forbidden",
    status: 403,
  });
  await expect(
    service.propose(
      { ...base, facts: [{ ...base.facts[0], scope: { kind: "system", name: "billing" }, wake: true }] } as never,
      principal,
    ),
  ).rejects.toMatchObject({ code: "agent_wake_forbidden", status: 403 });
  expect(statements).toHaveLength(0);
});

test("canonical remember merges provenance and confidence, and applies remembered wake metadata", async () => {
  const row = storedRow("Renewal window", "Renewal closes on Friday.", { confidence: 1, wake: true });
  const { service, rows } = dependencies(catalog, [row]);
  const result = await service.remember(
    {
      ...remember,
      confidence: "medium",
      wake: false,
      provenance: [{ sourceType: "human", actor: "untrusted-request-actor", capturedAt: "2026-10-18T10:25:00.000Z" }],
    },
    principal,
  );
  expect(result.outcomes[0]).toMatchObject({ recordId: row.id, outcome: "merged" });
  expect(rows()[0]).toMatchObject({ confidence: 1, wake: false, review_after: null, provenance_count: 2 });
});

test("a matching proposal preserves human wake metadata and cannot reactivate an invalidated fact", async () => {
  const active = storedRow("Renewal window", "Renewal closes on Friday.", { wake: true });
  const { service, rows } = dependencies(catalog, [active]);
  const wakeProposal = proposalFact({ actor: "alice", capturedAt: "2026-10-18T10:25:00.000Z" });
  await service.propose({ schemaVersion: 1, operationKey: "proposal-wake", facts: [wakeProposal] }, principal);
  expect(rows()[0]).toMatchObject({ wake: true, review_after: "2026-11-01" });

  const inactive = storedRow("Renewal window", "Renewal closes on Friday.", {
    active: false,
    invalidatedAt: "2026-10-18T10:10:00.000Z",
  });
  const inactiveDb = dependencies(catalog, [inactive]);
  const result = await inactiveDb.service.propose(
    { schemaVersion: 1, operationKey: "proposal-inactive", facts: [wakeProposal] },
    principal,
  );
  expect(result.outcomes[0]).toMatchObject({ recordId: inactive.id, outcome: "unchanged" });
  expect(inactiveDb.rows()[0]).toMatchObject({ active: false, invalidated_at: "2026-10-18T10:10:00.000Z" });
});

test("a proposal matching inactive history is unchanged even when a higher-confidence fact is active", async () => {
  const incumbent = storedRow("Renewal window", "Renewal closes on Monday.", { confidence: 1 });
  const historical = storedRow("Renewal window", "Renewal closes on Friday.", {
    active: false,
    supersededBy: incumbent.id,
  });
  const { service, rows } = dependencies(catalog, [historical, incumbent]);
  const result = await service.propose(
    {
      schemaVersion: 1,
      operationKey: "proposal-historical-conflict",
      facts: [proposalFact({ confidence: "low" })],
    },
    principal,
  );
  expect(result.outcomes[0]).toMatchObject({ recordId: historical.id, outcome: "unchanged" });
  expect(rows()[0]).toMatchObject({ active: false, superseded_by: incumbent.id });
  expect(rows()).toEqual([historical, incumbent]);
});

test("explicit remember reactivates historical content without a self-supersession link", async () => {
  const historical = storedRow("Renewal window", "Renewal closes on Friday.", {
    active: false,
    invalidatedAt: "2026-10-18T10:10:00.000Z",
    supersedes: "4a1b089c-6e3b-47da-b439-c259f42cf67a",
  });
  const { service, rows } = dependencies(catalog, [historical]);
  const result = await service.remember({ ...remember, operationKey: "reactivate" }, principal);
  expect(result.outcomes[0]).toMatchObject({ recordId: historical.id, outcome: "superseded" });
  expect(rows()[0]).toMatchObject({
    active: true,
    invalidated_at: null,
    superseded_by: null,
    supersedes: "4a1b089c-6e3b-47da-b439-c259f42cf67a",
  });
  expect(rows()[0]?.supersedes).not.toBe(historical.id);
});

test("confirmation and accepted request actor changes conflict under an existing operation key", async () => {
  const { service } = dependencies();
  const fact = proposalFact();
  await service.propose({ schemaVersion: 1, operationKey: "proposal-hash", facts: [fact] }, principal);
  await expect(
    service.propose(
      {
        schemaVersion: 1,
        operationKey: "proposal-hash",
        facts: [{ ...fact, confirmedAt: "2026-10-18T10:21:00.000Z" }],
      },
      principal,
    ),
  ).rejects.toMatchObject({ code: "operation_key_conflict" });

  const actorDb = dependencies();
  await actorDb.service.remember(remember, principal);
  await expect(
    actorDb.service.remember(
      {
        ...remember,
        provenance: [{ sourceType: "human", actor: "other-accepted-actor", capturedAt: "2026-10-18T10:20:00.000Z" }],
      },
      principal,
    ),
  ).rejects.toMatchObject({ code: "operation_key_conflict" });
});

test("scanner and embedding failures happen before any transaction or write", async () => {
  const scannerFailure = dependencies(catalog, [], {
    scanner: {
      scanPersistedDTO: async () => {
        throw new Error("scanner offline");
      },
    },
  });
  await expect(scannerFailure.service.remember(remember, principal)).rejects.toThrow("scanner offline");
  expect(scannerFailure.statements).toHaveLength(0);

  const embeddingFailure = dependencies(catalog, [], {
    embeddingProvider: {
      embed: async () => {
        throw new Error("provider offline");
      },
    },
  });
  await expect(embeddingFailure.service.remember(remember, principal)).rejects.toThrow("provider offline");
  expect(embeddingFailure.statements).toHaveLength(0);
});

test("a lower-confidence conflict on a later batch fact rolls back earlier inserts and the operation ledger", async () => {
  const incumbent = storedRow("Current policy", "Keep the prior policy.", { confidence: 1 });
  const { service, rows, state } = dependencies(catalog, [incumbent]);
  const proposal = {
    schemaVersion: 1 as const,
    operationKey: "atomic-batch",
    facts: [
      proposalFact({ title: "New policy", content: "A new independent fact." }),
      proposalFact({ title: "Current policy", content: "A weaker replacement.", confidence: "low" }),
    ],
  };
  await expect(service.propose(proposal, principal)).rejects.toMatchObject({ code: "lower_confidence_conflict" });
  expect(rows()).toEqual([incumbent]);
  expect(state()).toEqual({ operations: {} });
});

test("invalidating superseded history retains ancestry and removes queued reindex work", async () => {
  const successorId = randomUUID();
  const historical = storedRow("Renewal window", "Renewal closes on Friday.", {
    active: false,
    supersededBy: successorId,
  });
  const queued = enqueueReindex(
    { operations: {}, reindex: { pending: [] } },
    [
      { id: String(historical.id), contentHash: String(historical.content_hash) },
      { id: successorId, contentHash: "a".repeat(64) },
    ],
    "queue-before-forget",
  );
  const claimed = startRun(queued.state, {
    operationKey: "active-run",
    requestHash: "active-run-hash",
    operationId: "active-run-id",
    limit: 1,
    now: new Date("2026-10-18T10:00:00.000Z"),
    token: () => "forget-fenced-token",
  });
  if (claimed.kind !== "started") throw new Error("expected a claimed reindex entry");
  const { service, rows, state } = dependencies(catalog, [historical], {
    initialState: claimed.state,
  });
  const response = await service.invalidate(
    historical.id,
    { schemaVersion: 1, operationKey: "forget-superseded", reason: "reviewed" },
    principal,
  );
  expect(response.status).toBe("invalidated");
  expect(rows()[0]).toMatchObject({
    active: false,
    superseded_by: successorId,
    invalidation_reason: "reviewed",
    wake: false,
  });
  expect(readAdminState(state()).reindex.pending).toEqual([
    { id: successorId, contentHash: "a".repeat(64), attempts: 0 },
  ]);
  expect(readAdminState(state()).reindex.runs[claimed.runKey]?.progress.failed).toBe(1);
});

test("invalidate maps failed scope ownership to memory_forbidden", async () => {
  const row = storedRow("Domain policy", "Only domain owners may forget this.");
  row.scopes = ["domain:commerce"];
  const unauthorizedCatalog = { ...catalog, groups: [{ name: "payments", members: [] }] };
  const { service } = dependencies(unauthorizedCatalog, [row]);
  await expect(
    service.invalidate(
      row.id as string,
      { schemaVersion: 1, operationKey: "forget-forbidden", reason: "no" },
      principal,
    ),
  ).rejects.toMatchObject({ code: "memory_forbidden", status: 403 });
});
