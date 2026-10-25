import { expect, test } from "bun:test";
import { validateSnapshot } from "./snapshot";

import { fixture, manifest, memoryRow, metadataRow } from "./snapshot.fixture";

test("strict snapshot preserves all stored audit, vector and coordination values", () => {
  const input = fixture();
  expect(validateSnapshot(input, manifest)).toEqual(input);
});

test("snapshot refuses unknown format/table/column/state fields and unsupported versions", () => {
  for (const mutate of [
    (value: ReturnType<typeof fixture>) => {
      Object.assign(value, { schemaVersion: 2 });
    },
    (value: ReturnType<typeof fixture>) => {
      Object.assign(value, { sql: "DROP TABLE unrelated" });
    },
    (value: ReturnType<typeof fixture>) => {
      Object.assign(value.tables, { unrelated: [] });
    },
    (value: ReturnType<typeof fixture>) => {
      Object.assign(memoryRow(value), { extra: "value" });
    },
    (value: ReturnType<typeof fixture>) => {
      Reflect.deleteProperty(memoryRow(value), "tags");
    },
    (value: ReturnType<typeof fixture>) => {
      Object.assign(metadataRow(value).worker_state.reindex, { extra: true });
    },
  ]) {
    const value = fixture();
    mutate(value);
    expect(() => validateSnapshot(value, manifest)).toThrow("invalid memory snapshot");
  }
});

test("snapshot requires exact migrations, one matching profile, unique keys and supported wire rows", () => {
  for (const mutate of [
    (value: ReturnType<typeof fixture>) => {
      value.migrationManifest.migrations.reverse();
    },
    (value: ReturnType<typeof fixture>) => {
      value.tables.wagglebot_schema_migrations.pop();
    },
    (value: ReturnType<typeof fixture>) => {
      value.tables.wagglebot_memory_schema_metadata.push(metadataRow(value));
    },
    (value: ReturnType<typeof fixture>) => {
      metadataRow(value).dimension = 768;
    },
    (value: ReturnType<typeof fixture>) => {
      value.tables.wagglebot_memories.push(memoryRow(value));
    },
    (value: ReturnType<typeof fixture>) => {
      value.tables.wagglebot_memories.push({
        ...memoryRow(value),
        id: "33333333-3333-4333-8333-333333333333",
      });
    },
    (value: ReturnType<typeof fixture>) => {
      memoryRow(value).scopes.push("org");
    },
    (value: ReturnType<typeof fixture>) => {
      memoryRow(value).confidence = 0.75;
    },
    (value: ReturnType<typeof fixture>) => {
      memoryRow(value).embedding.pop();
    },
    (value: ReturnType<typeof fixture>) => {
      memoryRow(value).embedding[0] = Number.NaN;
    },
    (value: ReturnType<typeof fixture>) => {
      memoryRow(value).created_at = "2026-10-24T12:00:00+02:00";
    },
    (value: ReturnType<typeof fixture>) => {
      memoryRow(value).provenance_count = 0;
    },
    (value: ReturnType<typeof fixture>) => {
      Object.assign(metadataRow(value).worker_state.reindex, {
        pending: [{ id: "bad", contentHash: "a", attempts: 4 }],
      });
    },
    (value: ReturnType<typeof fixture>) => {
      Object.assign(metadataRow(value).worker_state.sources, {
        reviewed: {
          repository: "company/config",
          path: "knowledge/api.md",
          scope: { kind: "system", name: "core" },
          owner: "bad owner",
          currentRevision: "a".repeat(40),
          bodyHash: "b".repeat(64),
          revisions: ["a".repeat(40)],
          chunks: {},
        },
      });
    },
  ]) {
    const value = fixture();
    mutate(value);
    expect(() => validateSnapshot(value, manifest)).toThrow("invalid memory snapshot");
  }
});
