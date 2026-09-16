require "minitest/autorun"
require "tmpdir"
require "sequel"
require_relative "../lib/database"

class DatabaseTest < Minitest::Test
  def test_connection_requires_a_database_url_before_loading_a_driver
    error = assert_raises(Database::ConfigurationError) do
      Database.connection!(environment: {})
    end

    assert_equal "DATABASE_URL is required", error.message
  end

  def test_expected_manifest_uses_the_sorted_migration_filenames
    Dir.mktmpdir do |directory|
      File.write(File.join(directory, "20260916000002_add_index.rb"), "")
      File.write(File.join(directory, "20260916000001_create_memory.rb"), "")
      File.write(File.join(directory, "notes.txt"), "")

      assert_equal(
        {
          "latest" => "20260916000002",
          "migrations" => [
            "20260916000001_create_memory.rb",
            "20260916000002_add_index.rb",
          ],
        },
        Database.expected_manifest(directory),
      )
    end
  end

  def test_rollback_requires_an_explicit_timestamp_version
    error = assert_raises(Database::ConfigurationError) do
      Database.migration_version!(nil)
    end

    assert_equal "rollback requires a 14-digit migration version", error.message
  end

  def test_status_compares_timestamp_migration_filenames
    database = Struct.new(:applied_filenames) do
      def [](_table)
        self
      end

      def where(filename:)
        Struct.new(:count).new(applied_filenames.include?(filename) ? 1 : 0)
      end
    end.new(["20260916000001_create_memory.rb"])
    manifest = {
      "latest" => "20260916000002",
      "migrations" => [
        "20260916000001_create_memory.rb",
        "20260916000002_add_index.rb",
      ],
    }

    Database.stub(:expected_manifest, manifest) do
      assert_equal ["up 20260916000001_create_memory.rb", "down 20260916000002_add_index.rb"], Database.status(database)
    end
  end

  def test_generate_creates_a_reversible_timestamped_migration_and_manifest
    Dir.mktmpdir do |directory|
      migration_directory = File.join(directory, "migrations")
      manifest_path = File.join(directory, "migration-version.json")

      filename = Database.generate_migration!(
        "Create memory schema",
        now: Time.utc(2026, 9, 16, 12, 0, 0),
        migration_directory: migration_directory,
        manifest_path: manifest_path,
      )

      assert_equal "20260916120000_create_memory_schema.rb", filename
      assert_includes File.read(File.join(migration_directory, filename)), "up do"
      assert_includes File.read(File.join(migration_directory, filename)), "down do"
      assert_equal(
        {
          "latest" => "20260916120000",
          "migrations" => [filename],
        },
        JSON.parse(File.read(manifest_path)),
      )
    end
  end

  def test_migration_runner_loads_sequel_migration_support
    Database.load_migrator!

    assert defined?(Sequel::Migrator)
  end
end
