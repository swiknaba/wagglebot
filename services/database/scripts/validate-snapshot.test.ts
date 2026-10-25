import { expect, test } from "bun:test";
import { fixture, manifest, memoryRow } from "../../../packages/memory-storage/src/snapshot.fixture";
import { validateSnapshotMaterial } from "./validate-snapshot";

test("restore validator scans stored audit and state strings in bounded units before returning a snapshot", async () => {
  const input = fixture();
  Object.assign(memoryRow(input), { invalidation_reason: "audit secret" });
  const scanned: unknown[] = [];
  await expect(
    validateSnapshotMaterial(input, {
      manifest,
      scanner: {
        assertReady: async () => {},
        scanPersistedDTO: async (value) => {
          scanned.push(value);
          return { count: JSON.stringify(value).includes("audit secret") ? 1 : 0 };
        },
      },
    }),
  ).rejects.toThrow("snapshot validation failed");
  expect(scanned).toHaveLength(1);
  expect(JSON.stringify(scanned)).not.toContain('"embedding"');
});

test("restore validator fails closed when scanner is unavailable and never scans an invalid snapshot", async () => {
  let scans = 0;
  const scanner = {
    assertReady: async () => {
      throw new Error("private scanner detail");
    },
    scanPersistedDTO: async () => {
      scans += 1;
      return { count: 0 };
    },
  };
  await expect(validateSnapshotMaterial(fixture(), { manifest, scanner })).rejects.toThrow(
    "snapshot validation failed",
  );
  await expect(validateSnapshotMaterial({ ...fixture(), sql: "bad" }, { manifest, scanner })).rejects.toThrow(
    "snapshot validation failed",
  );
  expect(scans).toBe(0);
});

test("restore validator scans each persisted record separately rather than the complete archive", async () => {
  const input = fixture();
  const original = memoryRow(input);
  input.tables.wagglebot_memories.push({
    ...original,
    id: "33333333-3333-4333-8333-333333333333",
    canonical_key: "another",
  });
  const values: unknown[] = [];
  const result = await validateSnapshotMaterial(input, {
    manifest,
    scanner: {
      assertReady: async () => {},
      scanPersistedDTO: async (value) => {
        values.push(value);
        return { count: 0 };
      },
    },
  });
  expect(result).toEqual(input);
  expect(values).toHaveLength(3);
  expect(JSON.stringify(values)).not.toContain('"wagglebot_memories"');
});

test("restore validation preserves populated coordination state and scans nested source identities", async () => {
  const input = fixture();
  const id = memoryRow(input).id;
  const operationKey = "snapshot-run";
  const runKey = JSON.stringify(["operator", "configured-admin", operationKey]);
  const claim = { token: "claim-token", expiresAt: "2026-10-24T10:05:00Z", runKey };
  const state = {
    operations: {
      [JSON.stringify(["human", "alice", "forget"])]: {
        requestHash: "b".repeat(64),
        result: { schemaVersion: 1, operationKey: "forget", recordId: id, status: "invalidated" },
      },
    },
    sources: {
      reviewed: {
        repository: "company/config",
        path: "knowledge/api.md",
        scope: { kind: "system", name: "core" },
        owner: "team",
        currentRevision: "b".repeat(40),
        bodyHash: "a".repeat(64),
        revisions: ["b".repeat(40)],
        chunks: { one: id },
      },
    },
    reindex: {
      pending: [{ id, contentHash: "a".repeat(64), attempts: 1, claim }],
      runs: {
        [runKey]: {
          requestHash: "c".repeat(64),
          operationId: "run-id",
          expiresAt: claim.expiresAt,
          claims: [{ id, contentHash: "a".repeat(64), token: claim.token, status: "claimed" }],
          progress: { claimed: 1, completed: 0, failed: 0 },
          finalized: false,
        },
      },
    },
  };
  Object.assign(input.tables.wagglebot_memory_schema_metadata[0]?.worker_state ?? {}, state);
  const units: unknown[] = [];
  expect(
    await validateSnapshotMaterial(input, {
      manifest,
      scanner: {
        assertReady: async () => {},
        scanPersistedDTO: async (value) => {
          units.push(value);
          return { count: 0 };
        },
      },
    }),
  ).toEqual(input);
  expect(units).toHaveLength(6);
  expect(JSON.stringify(units)).toContain("claim-token");
  expect(JSON.stringify(units)).toContain("company/config");
  await expect(
    validateSnapshotMaterial(input, {
      manifest,
      scanner: {
        assertReady: async () => {},
        scanPersistedDTO: async (value) => ({ count: JSON.stringify(value).includes("company/config") ? 1 : 0 }),
      },
    }),
  ).rejects.toThrow("snapshot validation failed");
});

test("production validator fails closed without a pinned scanner and emits no snapshot bytes", async () => {
  const child = Bun.spawn([process.execPath, new URL("./validate-snapshot.ts", import.meta.url).pathname, "--scan"], {
    stdin: new TextEncoder().encode(JSON.stringify(fixture())),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, MEMORY_GITLEAKS_EXECUTABLE: "", MEMORY_GITLEAKS_SHA256: "" },
  });
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code).toBe(1);
  expect(output).toBe("");
  expect(error.trim()).toBe("snapshot validation failed");
});
