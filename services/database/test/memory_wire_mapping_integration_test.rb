require "minitest/autorun"
require "tmpdir"
require "sequel"
require_relative "../lib/database"

class MemoryWireMappingIntegrationTest < Minitest::Test
  def setup
    url = ENV.fetch("MEMORY_DATABASE_URL", "").strip
    skip "MEMORY_DATABASE_URL is required for memory wire mapping integration tests" if url.empty?

    @database = Sequel.connect(url, max_connections: 1)
    Database.migrate!(@database)
  end

  def teardown
    @database&.disconnect
  end

  def test_rollback_refuses_worker_state_and_can_be_reapplied_after_reset
    @database.run("UPDATE wagglebot_memory_schema_metadata SET worker_state = '{\"operations\":{\"used\":true},\"sources\":{},\"reindex\":{\"pending\":[]}}'::jsonb")

    assert_raises(Sequel::Error) { Database.rollback!(@database, "20260916130000") }
    assert @database.schema(:wagglebot_memories).any? { |column, _| column == :wake }

    @database.run("UPDATE wagglebot_memory_schema_metadata SET worker_state = '{\"operations\":{},\"sources\":{},\"reindex\":{\"pending\":[]}}'::jsonb")
    Database.rollback!(@database, "20260916130000")
    refute @database.schema(:wagglebot_memories).any? { |column, _| column == :wake }
    Database.migrate!(@database)
    assert @database.schema(:wagglebot_memories).any? { |column, _| column == :wake }
  end

  def test_schema_dump_contains_the_additive_wire_mapping
    Dir.mktmpdir do |directory|
      output = File.join(directory, "schema.sql")
      Database.dump_schema!(@database, output_path: output)
      schema = File.read(output)
      assert_includes schema, "wake boolean DEFAULT false NOT NULL"
      assert_includes schema, "review_after date"
      assert_includes schema, "supersedes text"
      assert_includes schema, "worker_state jsonb"
    end
  end
end
