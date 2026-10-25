require "minitest/autorun"

class CompleteMemoryWireMappingMigrationTest < Minitest::Test
  MIGRATION_PATH = File.expand_path("../db/migrations/20261006120000_complete_memory_wire_mapping.rb", __dir__)

  def test_adds_wire_mapping_and_worker_state_columns
    migration = File.read(MIGRATION_PATH)

    assert_includes migration, "add_column :wake, TrueClass, null: false, default: false"
    assert_includes migration, "add_column :review_after, Date"
    assert_includes migration, "add_column :supersedes, String"
    assert_includes migration, "add_column :worker_state, :jsonb"
  end

  def test_rollback_guards_nonempty_new_data
    migration = File.read(MIGRATION_PATH)

    assert_includes migration, "cannot roll back"
    assert_includes migration, "worker_state"
    assert_includes migration, "review_after"
    assert_includes migration, "supersedes"
  end
end
