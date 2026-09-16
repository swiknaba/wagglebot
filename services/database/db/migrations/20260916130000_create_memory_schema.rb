Sequel.migration do
  up do
    vector_available = get(Sequel.lit("EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')"))
    raise Sequel::Error, "pgvector extension is required before Wagglebot migrations" unless vector_available

    run "SELECT '[1,0]'::vector <=> '[1,0]'::vector"

    create_table(:wagglebot_memories) do
      String :id, primary_key: true
      String :canonical_key, null: false
      String :identity_key, null: false
      String :kind, null: false
      String :title, null: false
      String :text, text: true, null: false
      column :scopes, "text[]", null: false
      column :embedding, "vector(384)", null: false
      Float :confidence, null: false
      column :tags, "text[]", null: false, default: Sequel.lit("ARRAY[]::text[]")
      column :provenance, :jsonb, null: false
      TrueClass :active, null: false, default: true
      String :superseded_by
      DateTime :invalidated_at
      String :invalidation_reason
      String :content_hash, null: false
      Integer :provenance_count, null: false, default: 0
      DateTime :created_at, null: false, default: Sequel::CURRENT_TIMESTAMP
      DateTime :updated_at, null: false, default: Sequel::CURRENT_TIMESTAMP
    end
    add_index :wagglebot_memories, :canonical_key, unique: true, name: :wagglebot_memories_canonical_key_uidx
    add_index :wagglebot_memories, :scopes, type: :gin, name: :wagglebot_memories_scopes_gin_idx
    run "CREATE INDEX wagglebot_memories_embedding_hnsw_idx ON wagglebot_memories USING hnsw (embedding vector_cosine_ops)"

    create_table(:wagglebot_memory_schema_metadata) do
      String :provider, primary_key: true
      String :model, null: false
      Integer :dimension, null: false
      String :distance, null: false
      Integer :schema_version, null: false
      DateTime :created_at, null: false, default: Sequel::CURRENT_TIMESTAMP
    end
    from(:wagglebot_memory_schema_metadata).insert(
      provider: "xenova-transformers",
      model: "all-MiniLM-L6-v2",
      dimension: 384,
      distance: "cosine",
      schema_version: 1,
    )
  end

  down do
    drop_table(:wagglebot_memory_schema_metadata)
    drop_table(:wagglebot_memories)
  end
end
