require "minitest/autorun"
require "sequel"
require_relative "../lib/database"

class RollbackIntegrationTest < Minitest::Test
  def setup
    skip "DATABASE_URL is required for rollback integration tests" if ENV.fetch("DATABASE_URL", "").empty?

    @database = Database.connection!
    Database.migrate!(@database)
  end

  def teardown
    @database&.disconnect
  end

  def test_rolls_back_only_the_wagglebot_tables
    Database.rollback!(@database, "00000000000000")

    refute @database.table_exists?(:wagglebot_memories)
    refute @database.table_exists?(:wagglebot_memory_schema_metadata)
    assert @database.get(Sequel.lit("EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')"))
  end
end
