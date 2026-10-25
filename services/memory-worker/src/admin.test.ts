import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createAdminService } from "./admin";
import { ADMIN_EMBEDDING_PROFILE_ID } from "./admin-state";
import { EMBEDDING_PROFILE } from "./config";
import type { MemoryRepository } from "./repository";

type TestRow = Record<string, unknown>;

const recordId = "72a501fa-0ea1-4a27-9f96-9a90a5da7071";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function makeRecord(content = "a useful memory"): TestRow {
  return {
    id: recordId,
    canonical_key: `canonical:${sha(content)}`,
    identity_key: "identity:memory",
    kind: "fact",
    title: "Example memory",
    text: content,
    scopes: ["system:core"],
    embedding: `[${Array(384).fill(0).join(",")}]`,
    confidence: 0.5,
    provenance: [{ sourceType: "human", actor: "alice", capturedAt: "2026-10-18T00:00:00.000Z" }],
    provenance_count: 1,
    active: true,
    invalidated_at: null,
    invalidation_reason: null,
    wake: false,
    review_after: null,
    superseded_by: null,
    supersedes: null,
    content_hash: sha(content),
    created_at: "2026-10-18T00:00:00.000Z",
    updated_at: "2026-10-18T00:00:00.000Z",
  };
}

function fakeRepository(initialRecords: TestRow[] = [makeRecord()], beforeTransaction?: (records: TestRow[]) => void) {
  let state: Record<string, unknown> = { operations: {}, reindex: { pending: [] }, sources: {} };
  let records = structuredClone(initialRecords);
  let transactions = 0;
  const profile = {
    provider: EMBEDDING_PROFILE.provider,
    model: EMBEDDING_PROFILE.model,
    dimension: EMBEDDING_PROFILE.dimension,
    distance: EMBEDDING_PROFILE.distance,
    schema_version: 1,
  };

  const rowsFor = (collection: TestRow[], sql: string, values: unknown[] = []) => {
    if (sql.includes("SELECT * FROM wagglebot_memories WHERE id = $1"))
      return collection.filter((row) => row.id === values[0]);
    if (sql.includes("WHERE active = true")) return collection.filter((row) => row.active === true);
    return collection;
  };

  const repository = {
    assertReady: async () => undefined,
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("SELECT worker_state")) return [{ worker_state: structuredClone(state) }];
      return rowsFor(records, sql, values);
    },
    withTransaction: async <T>(
      callback: (transaction: { query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }> }) => Promise<T>,
    ) => {
      transactions += 1;
      beforeTransaction?.(records);
      let transactionState = structuredClone(state);
      const transactionRecords = structuredClone(records);
      const result = await callback({
        query: async (sql, values = []) => {
          if (sql.includes("SELECT worker_state")) return { rows: [{ worker_state: transactionState }] };
          if (sql.startsWith("UPDATE wagglebot_memory_schema_metadata SET worker_state")) {
            transactionState = JSON.parse(String(values[0]));
            return { rows: [] };
          }
          if (sql.includes("SELECT provider, model, dimension")) return { rows: [profile] };
          if (sql.startsWith("UPDATE wagglebot_memories SET active = false")) {
            const row = transactionRecords.find((candidate) => candidate.id === values[0]);
            if (row) {
              row.active = false;
              row.invalidated_at = values[1];
              row.invalidation_reason = values[2];
              row.wake = false;
              row.updated_at = values[1];
            }
            return { rows: [] };
          }
          if (sql.startsWith("UPDATE wagglebot_memories SET embedding")) {
            const row = transactionRecords.find((candidate) => candidate.id === values[0]);
            if (row) {
              row.embedding = values[1];
              row.updated_at = values[2];
            }
            return { rows: [] };
          }
          return { rows: rowsFor(transactionRecords, sql, values) };
        },
      });
      state = transactionState;
      records = transactionRecords;
      return result;
    },
    close: async () => undefined,
    readRecords: () => records,
    readState: () => state,
    transactionCount: () => transactions,
  };
  return repository as unknown as MemoryRepository & {
    readRecords(): TestRow[];
    readState(): Record<string, unknown>;
    transactionCount(): number;
  };
}

const cleanScanner = {
  scanPersistedDTO: async () => ({ findings: [], count: 0 }),
};

test("reindex validates the fixed profile and durably deduplicates an operation", async () => {
  const repository = fakeRepository();
  const service = createAdminService({
    repository,
    scanner: cleanScanner,
    embeddingProvider: { embed: async () => Array(384).fill(0) },
  });
  await expect(
    service.reindex({ schemaVersion: 1, operationKey: "bad", profileId: "11111111-1111-4111-8111-111111111111" }),
  ).rejects.toMatchObject({ code: "embedding_profile_invalid" });
  const request = { schemaVersion: 1, operationKey: "queue", profileId: ADMIN_EMBEDDING_PROFILE_ID };
  const first = await service.reindex(request);
  const replay = await service.reindex(request);
  expect(first).toMatchObject({ queued: 1 });
  expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
  expect((repository.readState().reindex as { pending: unknown[] }).pending).toHaveLength(1);
});

test("admin operations scan new keys, fail closed, and replay without rescanning", async () => {
  for (const operation of ["rescan", "reindex", "runOnce"] as const) {
    let scans = 0;
    const repository = fakeRepository();
    const service = createAdminService({
      repository,
      scanner: {
        scanPersistedDTO: async (value) => {
          scans += 1;
          return JSON.stringify(value).includes("token:synthetic-credential-value")
            ? { findings: [{ ruleId: "token_assignment" }], count: 1 }
            : { findings: [], count: 0 };
        },
      },
      embeddingProvider: { embed: async () => Array(384).fill(0) },
    });
    const request = { schemaVersion: 1, operationKey: "clean-admin-key" };
    const first = await service[operation](request);
    const callsAfterWrite = scans;
    expect(await service[operation](request)).toEqual(first);
    expect(scans).toBe(callsAfterWrite);

    const rejectedRepository = fakeRepository();
    const rejectingService = createAdminService({
      repository: rejectedRepository,
      scanner: {
        scanPersistedDTO: async (value) =>
          JSON.stringify(value).includes("token:synthetic-credential-value")
            ? { findings: [{ ruleId: "token_assignment" }], count: 1 }
            : { findings: [], count: 0 },
      },
      embeddingProvider: { embed: async () => Array(384).fill(0) },
    });
    await expect(
      rejectingService[operation]({ schemaVersion: 1, operationKey: "token:synthetic-credential-value" }),
    ).rejects.toMatchObject({ code: "secret_rejected", status: 422 });
    expect(rejectedRepository.transactionCount()).toBe(0);
    expect(rejectedRepository.readState().operations).toEqual({});
    expect(rejectedRepository.readState().reindex).toEqual({ pending: [] });
  }

  for (const operation of ["rescan", "reindex", "runOnce"] as const) {
    const unavailableRepository = fakeRepository();
    const unavailableService = createAdminService({
      repository: unavailableRepository,
      scanner: {
        scanPersistedDTO: async () => {
          throw new Error("scanner unavailable");
        },
      },
      embeddingProvider: { embed: async () => Array(384).fill(0) },
    });
    await expect(unavailableService[operation]({ schemaVersion: 1, operationKey: "new-key" })).rejects.toMatchObject({
      code: "scanner_unavailable",
      status: 503,
    });
    expect(unavailableRepository.transactionCount()).toBe(0);
    expect(unavailableRepository.readState().operations).toEqual({});
    expect(unavailableRepository.readState().reindex).toEqual({ pending: [] });
  }
});

test("run-once commits vectors and completion progress, then replays without re-embedding", async () => {
  const repository = fakeRepository();
  let embeddings = 0;
  const service = createAdminService({
    repository,
    scanner: cleanScanner,
    embeddingProvider: {
      embed: async () => {
        embeddings += 1;
        return Array(384).fill(0.25);
      },
    },
    clock: () => new Date("2026-10-18T10:00:00.000Z"),
    token: () => "claim-token",
    operationId: () => "stable-operation-id",
  });
  await service.reindex({ schemaVersion: 1, operationKey: "queue" });
  const request = { schemaVersion: 1, operationKey: "drain", limit: 1 };
  const first = await service.runOnce(request);
  const replay = await service.runOnce(request);
  expect(first).toEqual({
    schemaVersion: 1,
    operationKey: "drain",
    operationId: "stable-operation-id",
    claimed: 1,
    completed: 1,
    failed: 0,
  });
  expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
  expect(embeddings).toBe(1);
  expect(repository.readRecords()[0]?.embedding).toBe(`[${Array(384).fill(0.25).join(",")}]`);
});

test("provider failure is recorded and remains retryable under a new run key", async () => {
  const repository = fakeRepository();
  let calls = 0;
  const service = createAdminService({
    repository,
    scanner: cleanScanner,
    embeddingProvider: {
      embed: async () => {
        calls += 1;
        if (calls === 1) throw new Error("provider secret");
        return Array(384).fill(0.5);
      },
    },
    token: (() => {
      let token = 0;
      return () => `claim-${++token}`;
    })(),
  });
  await service.reindex({ schemaVersion: 1, operationKey: "queue" });
  const failed = await service.runOnce({ schemaVersion: 1, operationKey: "first-run", limit: 1 });
  expect(failed).toMatchObject({ claimed: 1, completed: 0, failed: 1 });
  expect(
    (repository.readState().reindex as { pending: Array<{ attempts: number; claim?: unknown }> }).pending[0],
  ).toMatchObject({ attempts: 1 });

  const retried = await service.runOnce({ schemaVersion: 1, operationKey: "retry-run", limit: 1 });
  expect(retried).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
  expect(calls).toBe(2);
});

test("a same-content title update fences an older embedding and remains retryable", async () => {
  const repository = fakeRepository();
  let embeddings = 0;
  const inputs: string[] = [];
  const service = createAdminService({
    repository,
    scanner: cleanScanner,
    embeddingProvider: {
      embed: async (input) => {
        inputs.push(input);
        embeddings += 1;
        if (embeddings === 1) {
          const row = repository.readRecords()[0];
          if (!row) throw new Error("missing fixture");
          row.title = "Updated publication title";
          row.embedding = `[${Array(384).fill(0.8).join(",")}]`;
        }
        return Array(384).fill(0.2);
      },
    },
  });
  await service.reindex({ schemaVersion: 1, operationKey: "queue-title" });
  const first = await service.runOnce({ schemaVersion: 1, operationKey: "stale-title" });
  expect(first).toMatchObject({ claimed: 1, completed: 0, failed: 1 });
  expect(repository.readRecords()[0]?.embedding).toBe(`[${Array(384).fill(0.8).join(",")}]`);
  expect(await service.runOnce({ schemaVersion: 1, operationKey: "fresh-title" })).toMatchObject({ completed: 1 });
  expect(inputs).toEqual(["Example memory\na useful memory", "Updated publication title\na useful memory"]);
});

test("a transient record read failure consumes an attempt without discarding queued work", async () => {
  const stored = fakeRepository();
  let unavailable = true;
  const repository: MemoryRepository = {
    ...stored,
    query: async (sql, values) => {
      if (unavailable && sql.includes("WHERE id = $1")) {
        unavailable = false;
        throw new Error("temporary database failure");
      }
      return stored.query(sql, values);
    },
  };
  const service = createAdminService({
    repository,
    scanner: cleanScanner,
    embeddingProvider: { embed: async () => Array(384).fill(0.2) },
  });
  await service.reindex({ schemaVersion: 1, operationKey: "queue-read-failure" });
  expect(await service.runOnce({ schemaVersion: 1, operationKey: "read-failure" })).toMatchObject({
    failed: 1,
    completed: 0,
  });
  expect((stored.readState().reindex as { pending: unknown[] }).pending).toEqual([
    { id: recordId, contentHash: sha("a useful memory"), attempts: 1 },
  ]);
  expect(await service.runOnce({ schemaVersion: 1, operationKey: "read-retry" })).toMatchObject({
    completed: 1,
    failed: 0,
  });
});

test("same-key callers wait for an active run, then recover its expired lease without stale writes", async () => {
  const repository = fakeRepository();
  let currentTime = new Date("2026-10-18T10:00:00.000Z");
  let signalStarted!: () => void;
  const embeddingStarted = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  let resolveEmbedding!: (value: number[]) => void;
  const providerResult = new Promise<number[]>((resolve) => {
    resolveEmbedding = resolve;
  });
  const service = createAdminService({
    repository,
    scanner: cleanScanner,
    embeddingProvider: {
      embed: async () => {
        signalStarted();
        return providerResult;
      },
    },
    clock: () => currentTime,
    token: () => "expiring-claim",
    operationId: () => "expired-operation",
  });
  await service.reindex({ schemaVersion: 1, operationKey: "queue" });
  const request = { schemaVersion: 1, operationKey: "same-run", limit: 1 };
  const first = service.runOnce(request);
  await embeddingStarted;
  await expect(service.runOnce(request)).rejects.toMatchObject({ code: "memory_unavailable", retryable: true });
  await expect(service.reindex({ schemaVersion: 1, operationKey: request.operationKey })).rejects.toMatchObject({
    code: "operation_key_conflict",
  });
  await expect(service.rescan({ schemaVersion: 1, operationKey: request.operationKey })).rejects.toMatchObject({
    code: "operation_key_conflict",
  });

  currentTime = new Date(currentTime.getTime() + 5 * 60 * 1000);
  const recovered = await service.runOnce(request);
  expect(recovered).toMatchObject({ claimed: 1, completed: 0, failed: 1, operationId: "expired-operation" });
  resolveEmbedding(Array(384).fill(0.9));
  await first;
  expect(repository.readRecords()[0]?.embedding).toBe(`[${Array(384).fill(0).join(",")}]`);
  expect(
    Object.hasOwn(
      repository.readState().operations as object,
      JSON.stringify(["operator", "configured-admin", "same-run"]),
    ),
  ).toBe(true);
});

test("rescan invalidates rejected active records and scanner failure leaves state untouched", async () => {
  const repository = fakeRepository([makeRecord("contains secret material")]);
  const service = createAdminService({
    repository,
    scanner: {
      scanPersistedDTO: async (record) =>
        JSON.stringify(record).includes("secret")
          ? { findings: [{ ruleId: "test-secret" }], count: 1 }
          : { findings: [], count: 0 },
    },
    embeddingProvider: { embed: async () => Array(384).fill(0) },
    clock: () => new Date("2026-10-18T10:00:00.000Z"),
  });
  const result = await service.rescan({ schemaVersion: 1, operationKey: "scan" });
  expect(result).toMatchObject({ scanned: 1, invalidated: 1, ruleIds: ["test-secret"] });
  expect(repository.readRecords()[0]).toMatchObject({ active: false, wake: false });

  const failingRepository = fakeRepository();
  const failingService = createAdminService({
    repository: failingRepository,
    scanner: {
      scanPersistedDTO: async () => {
        throw new Error("scanner unavailable");
      },
    },
    embeddingProvider: { embed: async () => Array(384).fill(0) },
  });
  await expect(failingService.rescan({ schemaVersion: 1, operationKey: "scan" })).rejects.toMatchObject({
    code: "scanner_unavailable",
  });
  expect(failingRepository.readState().operations).toEqual({});
  expect(failingRepository.readRecords()[0]?.active).toBe(true);
});

test("rescan rescans changed persisted material before invalidating it", async () => {
  const changedRecord = makeRecord("clean when first read");
  let changed = false;
  const repository = fakeRepository([changedRecord], (records) => {
    if (changed) return;
    changed = true;
    const current = records[0];
    if (!current) return;
    current.text = "now contains secret material";
    current.content_hash = sha(String(current.text));
  });
  let scans = 0;
  const service = createAdminService({
    repository,
    scanner: {
      scanPersistedDTO: async (record) => {
        scans += 1;
        return JSON.stringify(record).includes("secret")
          ? { findings: [{ ruleId: "test-secret" }], count: 1 }
          : { findings: [], count: 0 };
      },
    },
    embeddingProvider: { embed: async () => Array(384).fill(0) },
    clock: () => new Date("2026-10-18T10:00:00.000Z"),
  });
  const result = await service.rescan({ schemaVersion: 1, operationKey: "changed-material" });
  expect(scans).toBe(3);
  expect(result).toMatchObject({ scanned: 1, invalidated: 1, ruleIds: ["test-secret"] });
  expect(repository.readRecords()[0]).toMatchObject({ active: false, text: "now contains secret material" });
});

test("empty queues produce and durably replay a zero-count run result", async () => {
  const repository = fakeRepository([]);
  const service = createAdminService({
    repository,
    scanner: cleanScanner,
    embeddingProvider: { embed: async () => Array(384).fill(0) },
  });
  const request = { schemaVersion: 1, operationKey: "empty-run" };
  const result = await service.runOnce(request);
  expect(result).toMatchObject({ claimed: 0, completed: 0, failed: 0 });
  expect(JSON.stringify(await service.runOnce(request))).toBe(JSON.stringify(result));
});
