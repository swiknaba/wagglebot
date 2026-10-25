import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { decodeMemoryRecord } from "./record-mapping";
import { assertReady, memoryPool } from "./repository";

const databaseUrl = process.env.MEMORY_DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;
const pool = databaseUrl ? memoryPool() : undefined;
const metadataState = { operations: {}, sources: {}, reindex: { pending: [] } };

afterAll(async () => {
  await pool?.end();
});

integrationTest("inserts and reads a memory through native pgvector with wire mapping", async () => {
  await assertReady();
  const id = randomUUID();
  const vector = `[${Array(384).fill(0.125).join(",")}]`;
  try {
    await pool?.query(
      `INSERT INTO wagglebot_memories
        (id, canonical_key, identity_key, kind, title, text, scopes, embedding, confidence, tags, provenance, active, content_hash, provenance_count, wake, review_after, supersedes)
       VALUES ($1, $2, $3, 'fact', 'Database fixture', 'Native pgvector round trip.', ARRAY['system:memory-test'], $4::vector, 0.5, ARRAY[]::text[], $5::jsonb, true, $6, 1, true, '2026-11-06', $7)`,
      [
        id,
        `integration:${id}`,
        `integration:${id}`,
        vector,
        JSON.stringify([{ sourceType: "git", actor: "memory-test", capturedAt: "2026-10-06T10:00:00Z" }]),
        "a".repeat(64),
        "22222222-2222-4222-8222-222222222222",
      ],
    );
    const result = await pool?.query("SELECT * FROM wagglebot_memories WHERE id = $1", [id]);
    expect(decodeMemoryRecord(result?.rows[0] ?? {})).toMatchObject({
      id,
      confidence: "medium",
      wake: true,
      reviewAfter: "2026-11-06",
      supersedes: "22222222-2222-4222-8222-222222222222",
    });
    expect(result?.rows[0]?.embedding).toContain("0.125");
  } finally {
    await pool?.query("DELETE FROM wagglebot_memories WHERE id = $1", [id]);
  }
});

integrationTest("readiness rejects legacy rows, embedding metadata drift, and migration drift", async () => {
  await assertReady();
  const id = randomUUID();
  try {
    await pool?.query(
      `INSERT INTO wagglebot_memories
        (id, canonical_key, identity_key, kind, title, text, scopes, embedding, confidence, tags, provenance, active, content_hash, provenance_count)
       VALUES ($1, $2, $3, 'fact', 'Unsupported fixture', 'Multiple scopes are unsupported.', ARRAY['system:memory-test','org'], $4::vector, 1, ARRAY[]::text[], $5::jsonb, true, $6, 1)`,
      [
        id,
        `integration:${id}`,
        `integration:${id}`,
        `[${Array(384).fill("0").join(",")}]`,
        JSON.stringify([{ sourceType: "git", actor: "memory-test", capturedAt: "2026-10-06T10:00:00Z" }]),
        "b".repeat(64),
      ],
    );
    await expect(assertReady()).rejects.toThrow(/unsupported legacy memory row/i);
  } finally {
    await pool?.query("DELETE FROM wagglebot_memories WHERE id = $1", [id]);
  }

  try {
    await pool?.query("UPDATE wagglebot_memory_schema_metadata SET dimension = 768");
    await expect(assertReady()).rejects.toThrow(/embedding profile/i);
  } finally {
    await pool?.query("UPDATE wagglebot_memory_schema_metadata SET dimension = 384");
  }

  try {
    await pool?.query("INSERT INTO wagglebot_schema_migrations (filename) VALUES ($1)", [
      "99999999999999_unshipped.rb",
    ]);
    await expect(assertReady()).rejects.toThrow(/migration history/i);
  } finally {
    await pool?.query("DELETE FROM wagglebot_schema_migrations WHERE filename = $1", ["99999999999999_unshipped.rb"]);
  }

  await pool?.query("UPDATE wagglebot_memory_schema_metadata SET worker_state = $1::jsonb", [
    JSON.stringify(metadataState),
  ]);
  await expect(assertReady()).resolves.toBeUndefined();
});
