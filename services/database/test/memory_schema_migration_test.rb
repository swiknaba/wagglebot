require "minitest/autorun"

class MemorySchemaMigrationTest < Minitest::Test
  MIGRATION_PATH = File.expand_path("../db/migrations/20260916130000_create_memory_schema.rb", __dir__)

  def test_creates_the_documented_memory_tables_and_indexes
    migration = File.read(MIGRATION_PATH)

    assert_includes migration, "create_table(:wagglebot_memories)"
    assert_includes migration, "column :embedding, \"vector(384)\""
    assert_includes migration, "add_index :wagglebot_memories, :canonical_key, unique: true"
    assert_includes migration, "add_index :wagglebot_memories, :scopes, type: :gin"
    assert_includes migration, "vector_cosine_ops"
    assert_includes migration, "create_table(:wagglebot_memory_schema_metadata)"
    assert_includes migration, "all-MiniLM-L6-v2"
  end

  def test_drops_only_the_tables_created_by_the_migration
    migration = File.read(MIGRATION_PATH)

    assert_includes migration, "drop_table(:wagglebot_memory_schema_metadata)"
    assert_includes migration, "drop_table(:wagglebot_memories)"
    refute_includes migration, "DROP EXTENSION"
  end
end
