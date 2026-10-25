require "sequel"
require_relative "snapshot_test"

class SnapshotIntegrationTest < Minitest::Test
  include SnapshotFixtures

  def setup
    skip "DATABASE_URL is required for snapshot integration tests" if ENV.fetch("DATABASE_URL", "").empty?
    @database = Database.connection!
    Database.migrate!(@database)
  end

  def teardown
    @database&.disconnect
  end

  # Exercise the real structural validator. Opt in to the real scanner with
  # SNAPSHOT_SCAN_INTEGRATION=1; production restore always invokes --scan.
  def structural_validator
    lambda do |bytes, scan:|
      command = ["bun", Database::Snapshot::VALIDATOR]
      command << "--scan" if scan && ENV["SNAPSHOT_SCAN_INTEGRATION"] == "1"
      stdout, _stderr, status = Open3.capture3(*command, stdin_data: bytes)
      raise "validation failed" unless status.success?
      stdout
    end
  end

  def with_database
    @database.transaction(rollback: :always, auto_savepoint: true) do
      @database.create_table(:snapshot_sentinel) { String :value }
      @database[:snapshot_sentinel].insert(value: "preserve")
      yield
      assert_equal ["preserve"], @database[:snapshot_sentinel].select_map(:value)
      assert @database.get(Sequel.lit("EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')"))
      assert Database.check!(@database)
    end
  end

  def test_round_trip_preserves_audit_vectors_dates_and_durable_state
    with_database do
      Dir.mktmpdir do |directory|
        input = File.join(directory, "input.json")
        output = File.join(directory, "output.json")
        fixture = snapshot_fixture
        # SQL-looking values are data; they never become identifiers or statements.
        fixture["tables"]["wagglebot_memories"][0]["title"] = "'); DROP TABLE snapshot_sentinel; --"
        File.write(input, JSON.generate(fixture))
        scans = []
        validator = ->(bytes, scan:) { scans << scan; structural_validator.call(bytes, scan: scan) }
        assert_equal 2, Database::Snapshot.restore!(@database, input, validator: validator)[:memories]
        assert_equal 2, Database::Snapshot.backup!(@database, output, validator: validator)[:memories]
        assert_equal fixture, JSON.parse(File.read(output))
        assert_equal [true, false], scans
        assert_equal 0o600, File.stat(output).mode & 0o777
        assert_raises(Database::Snapshot::Error) { Database::Snapshot.backup!(@database, output, validator: validator) }
        link = File.join(directory, "symlink.json")
        File.symlink(input, link)
        assert_raises(Database::Snapshot::Error) { Database::Snapshot.backup!(@database, link, validator: validator) }
        assert_equal fixture, JSON.parse(File.read(input))
      end
    end
  end

  def test_restore_requires_exact_target_profile_and_migrations
    with_database do
      Dir.mktmpdir do |directory|
        path = File.join(directory, "snapshot.json")
        File.write(path, JSON.generate(snapshot_fixture))
        original = @database[:wagglebot_memories].all
        @database[:wagglebot_memory_schema_metadata].update(model: "unsupported")
        assert_raises(Database::Snapshot::Error) { Database::Snapshot.restore!(@database, path, validator: structural_validator) }
        assert_equal "unsupported", @database[:wagglebot_memory_schema_metadata].get(:model)
        assert_equal original, @database[:wagglebot_memories].all
        @database[:wagglebot_memory_schema_metadata].update(model: Database::Snapshot::PROFILE.fetch("model"))
        @database[:wagglebot_schema_migrations].insert(filename: "20990101000000_unknown.rb")
        assert_raises(Database::Snapshot::Error) { Database::Snapshot.restore!(@database, path, validator: structural_validator) }
        assert_equal original, @database[:wagglebot_memories].all
        @database[:wagglebot_schema_migrations].where(filename: "20990101000000_unknown.rb").delete
      end
    end
  end

  def test_insert_failure_rolls_back_memories_and_metadata_and_scanner_failure_never_mutates
    with_database do
      Dir.mktmpdir do |directory|
        path = File.join(directory, "snapshot.json")
        fixture = snapshot_fixture
        File.write(path, JSON.generate(fixture))
        Database::Snapshot.restore!(@database, path, validator: structural_validator)
        before = @database[:wagglebot_memories].all
        before_metadata = @database[:wagglebot_memory_schema_metadata].all
        @database.add_index(:wagglebot_memories, :title, unique: true, name: :snapshot_title_test_unique)
        second = fixture["tables"]["wagglebot_memories"][0].merge("id" => "44444444-4444-4444-8444-444444444444", "canonical_key" => "different")
        fixture["tables"]["wagglebot_memories"] << second
        fixture["tables"]["wagglebot_memory_schema_metadata"][0]["worker_state"]["operations"] = {}
        File.write(path, JSON.generate(fixture))
        assert_raises(Database::Snapshot::Error) { Database::Snapshot.restore!(@database, path, validator: structural_validator) }
        assert_equal before, @database[:wagglebot_memories].all
        assert_equal before_metadata, @database[:wagglebot_memory_schema_metadata].all
        assert_raises(Database::Snapshot::Error) { Database::Snapshot.restore!(@database, path, validator: ->(_bytes, scan:) { raise "unavailable" }) }
        assert_equal before, @database[:wagglebot_memories].all
      end
    end
  end
end
