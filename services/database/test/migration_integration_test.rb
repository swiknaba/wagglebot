require "minitest/autorun"
require "json"
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
    assert_includes @database.schema(:wagglebot_memories).map(&:first), :wake
    assert_includes @database.schema(:wagglebot_memories).map(&:first), :review_after
    assert_includes @database.schema(:wagglebot_memories).map(&:first), :supersedes
    assert_includes @database.schema(:wagglebot_memory_schema_metadata).map(&:first), :worker_state
    state = @database[:wagglebot_memory_schema_metadata].get(Sequel.lit("worker_state::text"))
    assert_equal({ "operations" => {}, "sources" => {}, "reindex" => { "pending" => [] } }, JSON.parse(state))
  end
end
