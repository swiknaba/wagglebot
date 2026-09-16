require "minitest/autorun"
require "sequel"
require_relative "../lib/database"

class MigrationIntegrationTest < Minitest::Test
  def setup
    skip "DATABASE_URL is required for migration integration tests" if ENV.fetch("DATABASE_URL", "").empty?

    @database = Database.connection!
  end

  def teardown
    @database&.disconnect
  end

  def test_applies_the_memory_schema_to_a_pgvector_database
    Database.migrate!(@database)

    assert @database.table_exists?(:wagglebot_memories)
    assert @database.table_exists?(:wagglebot_memory_schema_metadata)
    assert_equal "all-MiniLM-L6-v2", @database[:wagglebot_memory_schema_metadata].get(:model)
  end
end
