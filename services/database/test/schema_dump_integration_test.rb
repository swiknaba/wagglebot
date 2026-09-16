require "minitest/autorun"
require "tmpdir"
require "sequel"
require_relative "../lib/database"

class SchemaDumpIntegrationTest < Minitest::Test
  def setup
    skip "DATABASE_URL is required for schema dump integration tests" if ENV.fetch("DATABASE_URL", "").empty?

    @database = Database.connection!
    Database.migrate!(@database)
    @database.create_table?(:unrelated_table) { primary_key :id }
  end

  def teardown
    @database&.drop_table?(:unrelated_table)
    @database&.disconnect
  end

  def test_dumps_only_wagglebot_application_objects
    Dir.mktmpdir do |directory|
      output_path = File.join(directory, "schema.sql")

      Database.dump_schema!(
        @database,
        output_path: output_path,
        pg_dump: ENV.fetch("PG_DUMP"),
      )

      schema = File.read(output_path)
      assert_includes schema, "wagglebot_memories"
      assert_includes schema, "wagglebot_memory_schema_metadata"
      assert_includes schema, "wagglebot_schema_migrations"
      refute_includes schema, "unrelated_table"
      refute_includes schema, "CREATE EXTENSION"
    end
  end
end
