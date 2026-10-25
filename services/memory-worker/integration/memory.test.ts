import { afterAll, expect, test } from "bun:test";
import { canonicalize } from "../src/canonicalize";
import { createMemoryRepository } from "../src/repository";
import { createSearchService } from "../src/search-service";
import { createWriteService } from "../src/write-service";

const databaseUrl = process.env.MEMORY_DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;
const repository = databaseUrl ? createMemoryRepository() : undefined;
const vector = Array.from({ length: 384 }, () => 0.1);
const catalog = {
  users: [{ name: "alice", memberOf: [], orgOwner: false }],
  groups: [],
  systems: [{ name: "memory-test", owner: "memory-test-team", domain: "memory-test-domain" }],
  domains: [{ name: "memory-test-domain", owner: "memory-test-team" }],
};
const principal = {
  username: "alice",
  issuedAt: new Date("2026-10-18T10:00:00.000Z"),
  expiresAt: new Date("2026-10-18T11:00:00.000Z"),
  tokenId: "memory-integration",
  groups: [],
  orgOwner: false,
};
const dependencies = {
  repository: repository as NonNullable<typeof repository>,
  loadCatalog: async () => catalog as never,
  scanner: { scanPersistedDTO: async () => ({ findings: [], count: 0 }) },
  embeddingProvider: { embed: async () => vector },
  clock: () => new Date("2026-10-18T10:30:00.000Z"),
};

afterAll(async () => repository?.close());

integrationTest(
  "pgvector writes serialize replay, reconcile lifecycle, invalidate wake, and reactivate explicitly",
  async () => {
    const db = repository;
    if (!db) throw new Error("MEMORY_DATABASE_URL is required for memory integration tests");
    await db.assertReady();
    const originalStateRows = await db.query("SELECT worker_state FROM wagglebot_memory_schema_metadata");
    const originalState = originalStateRows[0]?.worker_state;
    const scope = { kind: "system" as const, name: "memory-test" };
    const identityKey = canonicalize({
      scope,
      kind: "fact",
      title: "Integration lifecycle",
      content: "first body",
    }).identityKey;
    const service = createWriteService(dependencies);
    const search = createSearchService(dependencies);
    const base = {
      schemaVersion: 1 as const,
      operationKey: `memory-integration-${crypto.randomUUID()}`,
      scope,
      kind: "fact" as const,
      title: "Integration lifecycle",
      content: "first body",
      confidence: "high" as const,
      wake: true,
      reviewAfter: "2026-11-06",
      provenance: [{ sourceType: "human" as const, actor: "alice", capturedAt: "2026-10-18T10:20:00Z" }],
    };

    try {
      const concurrent = await Promise.all([service.remember(base, principal), service.remember(base, principal)]);
      expect(concurrent[0]).toEqual(concurrent[1]);
      const firstId = concurrent[0]?.outcomes[0]?.recordId;
      if (!firstId) throw new Error("first operation did not return a record ID");
      const firstRows = await db.query("SELECT id FROM wagglebot_memories WHERE identity_key = $1 AND active = true", [
        identityKey,
      ]);
      expect(firstRows.map((row) => row.id)).toEqual([firstId]);

      await expect(service.remember({ ...base, content: "different request" }, principal)).rejects.toMatchObject({
        code: "operation_key_conflict",
      });
      await expect(
        service.remember(
          {
            ...base,
            operationKey: `${base.operationKey}-lower`,
            content: "lower confidence",
            confidence: "low",
            wake: false,
          },
          principal,
        ),
      ).rejects.toMatchObject({
        code: "lower_confidence_conflict",
      });

      const replacement = await service.remember(
        { ...base, operationKey: `${base.operationKey}-replacement`, content: "second body" },
        principal,
      );
      const replacementId = replacement.outcomes[0]?.recordId;
      if (!replacementId) throw new Error("replacement did not return a record ID");
      expect(replacement.outcomes[0]?.outcome).toBe("superseded");
      const historical = await search.get(firstId, principal);
      expect(historical.record.status).toBe("superseded");

      const cascade = { system: "memory-test", domain: "memory-test-domain", includeOrg: true as const };
      const searchResult = await search.search(
        { schemaVersion: 1, purpose: "query", query: "second body", cascade, scopes: [scope], limit: 10 },
        principal,
      );
      expect(searchResult.records.map(({ record }) => record.id)).toEqual([replacementId]);

      await db.query(
        "UPDATE wagglebot_memory_schema_metadata SET worker_state = jsonb_set(worker_state, '{reindex,pending}', $1::jsonb)",
        [JSON.stringify([{ id: replacementId, contentHash: "a".repeat(64), attempts: 0 }])],
      );
      await service.invalidate(
        replacementId,
        { schemaVersion: 1, operationKey: `${base.operationKey}-forget`, reason: "test" },
        principal,
      );
      const stateAfterForget = await db.query("SELECT worker_state FROM wagglebot_memory_schema_metadata");
      const workerState = stateAfterForget[0]?.worker_state as { reindex: { pending: unknown[] } } | undefined;
      if (!workerState) throw new Error("missing worker state after invalidation");
      expect(workerState.reindex.pending).toEqual([]);
      const afterForget = await search.search(
        { schemaVersion: 1, purpose: "query", query: "second body", cascade, scopes: [scope], limit: 10 },
        principal,
      );
      expect(afterForget.records).toEqual([]);

      const reactivated = await service.remember(
        { ...base, operationKey: `${base.operationKey}-reactivate`, content: "second body" },
        principal,
      );
      expect(reactivated.outcomes[0]?.recordId).toBe(replacementId);
      const current = await search.get(replacementId, principal);
      expect(current.record.status).toBe("active");
      expect(current.record.wake).toBe(true);
    } finally {
      await db.query("DELETE FROM wagglebot_memories WHERE identity_key = $1", [identityKey]);
      if (originalState !== undefined) {
        await db.query("UPDATE wagglebot_memory_schema_metadata SET worker_state = $1::jsonb", [
          JSON.stringify(originalState),
        ]);
      }
    }
  },
);
