export const manifest = {
  latest: "20261006120000",
  migrations: ["20260916130000_create_memory_schema.rb", "20261006120000_complete_memory_wire_mapping.rb"],
};
export function fixture() {
  return {
    schemaVersion: 1 as const,
    embeddingProfileId: "7101cc0e-6a04-503b-8d23-329b99cff42f",
    migrationManifest: structuredClone(manifest),
    tables: {
      wagglebot_memories: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          canonical_key: "canonical",
          identity_key: "identity",
          kind: "fact",
          title: "Useful policy",
          text: "Reviewed policy text",
          scopes: ["system:core"],
          embedding: Array.from({ length: 384 }, () => 0.1),
          confidence: 1,
          tags: ["reviewed"],
          provenance: [{ sourceType: "human", actor: "alice", capturedAt: "2026-10-24T10:00:00Z" }],
          active: true,
          superseded_by: null,
          invalidated_at: null,
          invalidation_reason: null,
          content_hash: "a".repeat(64),
          provenance_count: 1,
          created_at: "2026-10-24T10:00:00Z",
          updated_at: "2026-10-24T10:00:00Z",
          wake: false,
          review_after: null,
          supersedes: null,
        },
      ],
      wagglebot_memory_schema_metadata: [
        {
          provider: "xenova-transformers",
          model: "all-MiniLM-L6-v2",
          dimension: 384,
          distance: "cosine",
          schema_version: 1,
          created_at: "2026-10-24T10:00:00Z",
          worker_state: { operations: {}, sources: {}, reindex: { pending: [] } },
        },
      ],
      wagglebot_schema_migrations: manifest.migrations.map((filename) => ({ filename })),
    },
  };
}

export function memoryRow(value: ReturnType<typeof fixture>) {
  const row = value.tables.wagglebot_memories[0];
  if (!row) throw new Error("missing fixture row");
  return row;
}
export function metadataRow(value: ReturnType<typeof fixture>) {
  const row = value.tables.wagglebot_memory_schema_metadata[0];
  if (!row) throw new Error("missing fixture metadata");
  return row;
}
