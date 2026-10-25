import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createAdminService } from "../src/admin";
import { readAdminState } from "../src/admin-state";
import { createMemoryRepository } from "../src/repository";
import { createWriteService } from "../src/write-service";

const repository = process.env.MEMORY_DATABASE_URL ? createMemoryRepository() : undefined;
const integrationTest = repository ? test : test.skip;
afterAll(async () => repository?.close());

integrationTest("pgvector admin claims survive restart, reject key reuse, and fence invalidated work", async () => {
  const db = repository;
  if (!db) throw new Error("MEMORY_DATABASE_URL is required for admin integration tests");
  await db.assertReady();
  const originalState = (await db.query("SELECT worker_state FROM wagglebot_memory_schema_metadata"))[0]?.worker_state;
  const operationKey = `admin-integration-${randomUUID()}`;
  const recordIds: string[] = [];
  const now = new Date("2026-10-24T10:00:00Z");
  const principal = {
    username: "alice",
    issuedAt: new Date("2026-10-24T09:00:00Z"),
    expiresAt: new Date("2026-10-24T11:00:00Z"),
    tokenId: "admin-integration",
    groups: [],
    orgOwner: false,
  };
  const scanner = { scanPersistedDTO: async () => ({ findings: [], count: 0 }) };
  const writes = createWriteService({
    repository: db,
    loadCatalog: async () =>
      ({
        users: [{ name: "alice", orgOwner: false }],
        groups: [],
        systems: [{ name: "admin-test" }],
        domains: [],
      }) as never,
    scanner,
    embeddingProvider: { embed: async () => Array(384).fill(0.1) },
    clock: () => now,
  });
  const admin = (embed: (text: string) => Promise<number[]>, scan = scanner.scanPersistedDTO) =>
    createAdminService({
      repository: db,
      scanner: { scanPersistedDTO: scan },
      embeddingProvider: { embed },
      clock: () => now,
    });
  try {
    const written = await writes.remember(
      {
        schemaVersion: 1,
        operationKey: `${operationKey}-remember`,
        scope: { kind: "system", name: "admin-test" },
        kind: "fact",
        title: operationKey,
        content: "Administrator integration fixture",
        confidence: "high",
        wake: false,
        provenance: [{ sourceType: "human", actor: "alice", capturedAt: now.toISOString() }],
      },
      principal,
    );
    const id = written.outcomes[0]?.recordId;
    if (!id) throw new Error("fixture did not return a record ID");
    recordIds.push(id);
    const queueRequest = { schemaVersion: 1, operationKey: `${operationKey}-queue` };
    const first = admin(async () => Array(384).fill(0.2));
    const queued = await first.reindex(queueRequest);
    expect(queued.queued).toBeGreaterThanOrEqual(1);
    const restarted = admin(async () => {
      throw new Error("provider unavailable");
    });
    expect(await restarted.reindex(queueRequest)).toEqual(queued);

    const drainRequest = { schemaVersion: 1, operationKey: `${operationKey}-drain`, limit: 100 };
    const failed = await restarted.runOnce(drainRequest);
    if (!failed) throw new Error("run-once did not return a result");
    expect(failed.failed).toBe(failed.claimed);
    expect(failed.failed).toBeGreaterThanOrEqual(1);
    expect(await first.runOnce(drainRequest)).toEqual(failed);

    let signalStarted!: () => void;
    let finishEmbedding!: (vector: number[]) => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const pending = new Promise<number[]>((resolve) => {
      finishEmbedding = resolve;
    });
    const blocked = admin(async () => {
      signalStarted();
      return pending;
    });
    const blockedKey = `${operationKey}-blocked`;
    const running = blocked.runOnce({ schemaVersion: 1, operationKey: blockedKey, limit: 100 });
    await started;
    try {
      await expect(first.runOnce({ schemaVersion: 1, operationKey: blockedKey, limit: 100 })).rejects.toMatchObject({
        code: "memory_unavailable",
      });
      await expect(first.reindex({ schemaVersion: 1, operationKey: blockedKey })).rejects.toMatchObject({
        code: "operation_key_conflict",
      });
      const beforeScan = (await db.query("SELECT worker_state FROM wagglebot_memory_schema_metadata"))[0]?.worker_state;
      const unavailable = admin(
        async () => Array(384).fill(0.2),
        async () => {
          throw new Error("scanner unavailable");
        },
      );
      const scanRequest = { schemaVersion: 1, operationKey: `${operationKey}-rescan` };
      await expect(unavailable.rescan(scanRequest)).rejects.toMatchObject({ code: "scanner_unavailable" });
      expect((await db.query("SELECT worker_state FROM wagglebot_memory_schema_metadata"))[0]?.worker_state).toEqual(
        beforeScan,
      );
      const rejecting = createAdminService({
        repository: db,
        scanner: {
          scanPersistedDTO: async (record) =>
            (record as { id?: string }).id === id
              ? { findings: [{ ruleId: "integration-rule" }], count: 1 }
              : { findings: [], count: 0 },
        },
        embeddingProvider: { embed: async () => Array(384).fill(0.2) },
        clock: () => now,
      });
      const scanned = await rejecting.rescan(scanRequest);
      expect(scanned).toMatchObject({ invalidated: 1, ruleIds: ["integration-rule"] });
      expect(await unavailable.rescan(scanRequest)).toEqual(scanned);
    } finally {
      finishEmbedding(Array(384).fill(0.9));
      await running;
    }
    const row = (await db.query("SELECT active, embedding FROM wagglebot_memories WHERE id = $1", [id]))[0];
    expect(row?.active).toBe(false);
    expect(row?.embedding).toBe(`[${Array(384).fill(0.1).join(",")}]`);
    const state = readAdminState(
      (await db.query("SELECT worker_state FROM wagglebot_memory_schema_metadata"))[0]?.worker_state,
    );
    expect(state.reindex.pending.some((entry) => entry.id === id)).toBe(false);
    const replay = await first.runOnce({ schemaVersion: 1, operationKey: blockedKey, limit: 100 });
    if (!replay) throw new Error("run-once did not replay a result");
    expect(replay.failed).toBeGreaterThanOrEqual(1);
  } finally {
    for (const id of recordIds) await db.query("DELETE FROM wagglebot_memories WHERE id = $1", [id]);
    if (originalState !== undefined)
      await db.query("UPDATE wagglebot_memory_schema_metadata SET worker_state = $1::jsonb", [
        JSON.stringify(originalState),
      ]);
  }
});

integrationTest("pgvector recovery preserves partial progress and fences an expired worker after reclaim", async () => {
  const db = repository;
  if (!db) throw new Error("MEMORY_DATABASE_URL is required for admin integration tests");
  await db.assertReady();
  const originalState = (await db.query("SELECT worker_state FROM wagglebot_memory_schema_metadata"))[0]?.worker_state;
  const prefix = `recovery-${randomUUID()}`;
  const ids: string[] = [];
  let now = new Date("2026-10-24T10:00:00Z");
  const scanner = { scanPersistedDTO: async () => ({ findings: [], count: 0 }) };
  const writes = createWriteService({
    repository: db,
    loadCatalog: async () => ({
      users: [{ name: "alice", memberOf: [], orgOwner: false }],
      groups: [{ name: "team", members: ["alice"] }],
      systems: [{ name: "recovery-test", owner: "team", domain: "recovery-domain" }],
      domains: [{ name: "recovery-domain", owner: "team" }],
    }),
    scanner,
    embeddingProvider: { embed: async () => Array(384).fill(0.1) },
    clock: () => now,
  });
  const principal = {
    username: "alice",
    issuedAt: new Date("2026-10-24T09:00:00Z"),
    expiresAt: new Date("2026-10-24T11:00:00Z"),
    tokenId: prefix,
    groups: ["team"],
    orgOwner: false,
  };
  const deferred = () => {
    let release!: (vector: number[]) => void;
    let started!: () => void;
    const vector = new Promise<number[]>((resolve) => {
      release = resolve;
    });
    const signal = new Promise<void>((resolve) => {
      started = resolve;
    });
    return { vector, signal, release, started };
  };
  const old = deferred();
  const fresh = deferred();
  const jobs: Promise<unknown>[] = [];
  const admin = (embed: (text: string) => Promise<number[]>) =>
    createAdminService({ repository: db, scanner, embeddingProvider: { embed }, clock: () => now });
  try {
    for (let index = 0; index < 3; index += 1) {
      const result = await writes.remember(
        {
          schemaVersion: 1,
          operationKey: `${prefix}-seed-${index}`,
          scope: { kind: "system", name: "recovery-test" },
          kind: "fact",
          title: `${prefix}-${index}`,
          content: "Recoverable fixture",
          confidence: "high",
          wake: false,
          provenance: [{ sourceType: "human", actor: "alice", capturedAt: now.toISOString() }],
        },
        principal,
      );
      const id = result.outcomes[0]?.recordId;
      if (!id) throw new Error("missing fixture ID");
      ids.push(id);
    }
    ids.sort();
    let calls = 0;
    const first = admin(async () => {
      calls += 1;
      if (calls === 1) return Array(384).fill(0.2);
      old.started();
      return old.vector;
    });
    await first.reindex({ schemaVersion: 1, operationKey: `${prefix}-queue` });
    const request = { schemaVersion: 1, operationKey: `${prefix}-partial`, limit: 2 };
    const running = first.runOnce(request);
    jobs.push(running);
    await old.signal;
    const runKey = JSON.stringify(["operator", "configured-admin", request.operationKey]);
    const readState = async () =>
      readAdminState((await db.query("SELECT worker_state FROM wagglebot_memory_schema_metadata"))[0]?.worker_state);
    expect((await readState()).reindex.runs[runKey]?.progress).toEqual({ claimed: 2, completed: 1, failed: 0 });

    const other = admin(async () => Array(384).fill(0.3));
    expect(await other.runOnce({ schemaVersion: 1, operationKey: `${prefix}-concurrent`, limit: 1 })).toMatchObject({
      claimed: 1,
      completed: 1,
      failed: 0,
    });
    const afterConcurrent = await readState();
    const otherKey = JSON.stringify(["operator", "configured-admin", `${prefix}-concurrent`]);
    expect(afterConcurrent.reindex.runs[runKey]?.claims.map((claim) => claim.id)).toEqual(ids.slice(0, 2));
    expect(afterConcurrent.reindex.runs[otherKey]?.claims.map((claim) => claim.id)).toEqual(ids.slice(2));

    now = new Date(now.getTime() + 5 * 60 * 1000);
    const restarted = admin(async () => {
      fresh.started();
      return fresh.vector;
    });
    expect(await restarted.runOnce(request)).toMatchObject({ claimed: 2, completed: 1, failed: 1 });
    const newer = restarted.runOnce({ schemaVersion: 1, operationKey: `${prefix}-reclaimed`, limit: 1 });
    jobs.push(newer);
    await fresh.signal;
    const claimedBefore = (await readState()).reindex.pending[0]?.claim;
    if (!claimedBefore) throw new Error("restarted worker did not claim pending work");
    old.release(Array(384).fill(0.9));
    expect(await running).toMatchObject({ claimed: 2, completed: 1, failed: 1 });
    expect((await readState()).reindex.pending[0]?.claim).toEqual(claimedBefore);
    expect((await db.query("SELECT embedding FROM wagglebot_memories WHERE id = $1", [ids[1]]))[0]?.embedding).toBe(
      `[${Array(384).fill(0.1).join(",")}]`,
    );
    fresh.release(Array(384).fill(0.7));
    expect(await newer).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect((await readState()).reindex.pending).toHaveLength(0);
    expect((await db.query("SELECT embedding FROM wagglebot_memories WHERE id = $1", [ids[1]]))[0]?.embedding).toBe(
      `[${Array(384).fill(0.7).join(",")}]`,
    );
  } finally {
    old.release(Array(384).fill(0.9));
    fresh.release(Array(384).fill(0.7));
    await Promise.allSettled(jobs);
    for (const id of ids) await db.query("DELETE FROM wagglebot_memories WHERE id = $1", [id]);
    if (originalState !== undefined)
      await db.query("UPDATE wagglebot_memory_schema_metadata SET worker_state = $1::jsonb", [
        JSON.stringify(originalState),
      ]);
  }
});
