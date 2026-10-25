require "minitest/autorun"
require "tmpdir"
require_relative "../lib/snapshot"

module SnapshotFixtures
  def snapshot_fixture
    active_id = "22222222-2222-4222-8222-222222222222"
    run_key = JSON.generate(["operator", "configured-admin", "snapshot-run"])
    claim_token = "snapshot-claim-token"
    expires_at = "2026-10-24T10:05:00.000000Z"
    active_memory = memory_fixture.merge(
      "id" => active_id, "canonical_key" => "active-canonical", "identity_key" => "active-identity",
      "title" => "An active fact", "active" => true, "invalidated_at" => nil, "invalidation_reason" => nil,
    )
    state = {
      "operations" => {
        JSON.generate(["human", "reviewer", "snapshot-forget"]) => {
          "requestHash" => "a" * 64,
          "result" => { "schemaVersion" => 1, "operationKey" => "snapshot-forget", "recordId" => memory_fixture.fetch("id"), "status" => "invalidated" },
        },
      },
      "sources" => {
        "source" => {
          "repository" => "example/repository", "path" => "knowledge/fact.md",
          "scope" => { "kind" => "system", "name" => "billing" }, "owner" => "reviewer",
          "currentRevision" => "b" * 40, "bodyHash" => "a" * 64,
          "revisions" => ["b" * 40], "chunks" => { "chunk" => active_id },
        },
      },
      "reindex" => {
        "pending" => [{
          "id" => active_id, "contentHash" => "c" * 64, "attempts" => 1,
          "claim" => { "token" => claim_token, "expiresAt" => expires_at, "runKey" => run_key },
        }],
        "runs" => {
          run_key => {
            "requestHash" => "d" * 64, "operationId" => "33333333-3333-4333-8333-333333333333", "expiresAt" => expires_at,
            "claims" => [{ "id" => active_id, "contentHash" => "c" * 64, "token" => claim_token, "status" => "claimed" }],
            "progress" => { "claimed" => 1, "completed" => 0, "failed" => 0 }, "finalized" => false,
          },
        },
      },
    }
    {
      "schemaVersion" => 1,
      "embeddingProfileId" => Database::Snapshot::PROFILE_ID,
      "migrationManifest" => Database::Snapshot.manifest,
      "tables" => {
        "wagglebot_memories" => [memory_fixture, active_memory],
        "wagglebot_memory_schema_metadata" => [Database::Snapshot::PROFILE.merge(
          "created_at" => "2026-10-24T10:00:00.000000Z",
          "worker_state" => state,
        )],
        "wagglebot_schema_migrations" => Database::Snapshot.manifest.fetch("migrations").map { |filename| { "filename" => filename } },
      },
    }
  end

  def memory_fixture
    {
      "id" => "11111111-1111-4111-8111-111111111111", "canonical_key" => "canonical", "identity_key" => "identity", "kind" => "fact", "title" => "A reviewed fact", "text" => "A reviewed fact.", "scopes" => ["system:billing"], "embedding" => [1.0] + Array.new(383, 0.0), "confidence" => 1.0, "tags" => ["audit"], "provenance" => [{ "sourceType" => "human", "actor" => "reviewer", "capturedAt" => "2026-10-24T09:00:00Z" }], "active" => false, "superseded_by" => nil, "invalidated_at" => "2026-10-24T10:00:00.000000Z", "invalidation_reason" => "Reviewed", "content_hash" => "c" * 64, "provenance_count" => 1, "created_at" => "2026-10-24T09:00:00.000000Z", "updated_at" => "2026-10-24T10:00:00.000000Z", "wake" => false, "review_after" => "2026-10-24", "supersedes" => nil,
    }
  end

  def passthrough_validator
    ->(bytes, scan:) { bytes }
  end
end

class SnapshotTest < Minitest::Test
  include SnapshotFixtures

  def validate(snapshot)
    Database::Snapshot.validate!(JSON.generate(snapshot), scan: true, validator: passthrough_validator)
  end

  def test_validated_format_preserves_audit_and_worker_state
    fixture = snapshot_fixture
    assert_equal fixture, validate(fixture)
  end

  def test_rejects_unknown_objects_columns_and_wrong_types_before_database_access
    mutations = [
      ->(value) { value["sql"] = "DROP TABLE sentinel" },
      ->(value) { value["tables"]["sentinel"] = [] },
      ->(value) { value["tables"]["wagglebot_memories"][0]["title; DROP TABLE sentinel"] = "bad" },
      ->(value) { value["tables"]["wagglebot_memories"][0]["embedding"] = "[1]; DROP TABLE sentinel" },
      ->(value) { value["tables"]["wagglebot_memories"][0]["provenance"] = "{}" },
      ->(value) { value["tables"]["wagglebot_memory_schema_metadata"][0]["worker_state"] = [] },
      ->(value) { value["migrationManifest"]["migrations"] = [] },
      ->(value) { value["tables"]["wagglebot_schema_migrations"] = [] },
      ->(value) { value["tables"]["wagglebot_memories"] << value["tables"]["wagglebot_memories"][0].dup },
    ]
    mutations.each do |mutation|
      fixture = snapshot_fixture
      mutation.call(fixture)
      error = assert_raises(Database::Snapshot::Error) { validate(fixture) }
      assert_equal "snapshot validation failed", error.message
      assert_nil error.cause
    end
  end

  def test_production_validator_uses_only_fixed_argument_array_and_stdin
    bytes = JSON.generate(snapshot_fixture)
    calls = []
    capture = lambda do |*command, stdin_data:|
      calls << [command, stdin_data]
      [bytes, "", Struct.new(:success?).new(true)]
    end
    Open3.stub(:capture3, capture) do
      Database::Snapshot.validate!(bytes, scan: true)
      Database::Snapshot.validate!(bytes, scan: false)
    end
    assert_equal [["bun", Database::Snapshot::VALIDATOR, "--scan"], bytes], calls[0]
    assert_equal [["bun", Database::Snapshot::VALIDATOR], bytes], calls[1]
    assert File.absolute_path(Database::Snapshot::VALIDATOR) == Database::Snapshot::VALIDATOR
  end

  def test_restore_reads_and_scans_before_touching_database_and_hides_errors
    Dir.mktmpdir do |directory|
      path = File.join(directory, "snapshot.json")
      File.write(path, JSON.generate(snapshot_fixture))
      observed = nil
      validator = lambda do |bytes, scan:|
        observed = [bytes, scan]
        raise "secret source and DSN"
      end
      error = assert_raises(Database::Snapshot::Error) { Database::Snapshot.restore!(Object.new, path, validator: validator) }
      assert_equal [File.binread(path), true], observed
      assert_equal "snapshot restore failed", error.message
      assert_nil error.cause
    end
  end
end
