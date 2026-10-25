require "json"
require "time"
require "date"
require "open3"
require_relative "database"

module Database
  module Snapshot
    class Error < StandardError; end

    PROFILE_ID = "7101cc0e-6a04-503b-8d23-329b99cff42f".freeze
    VALIDATOR = File.expand_path("../scripts/validate-snapshot.ts", __dir__).freeze
    MEMORY_COLUMNS = %w[id canonical_key identity_key kind title text scopes embedding confidence tags provenance active superseded_by invalidated_at invalidation_reason content_hash provenance_count created_at updated_at wake review_after supersedes].freeze
    METADATA_COLUMNS = %w[provider model dimension distance schema_version created_at worker_state].freeze
    TABLE_COLUMNS = {
      "wagglebot_memories" => MEMORY_COLUMNS,
      "wagglebot_memory_schema_metadata" => METADATA_COLUMNS,
      "wagglebot_schema_migrations" => %w[filename].freeze,
    }.freeze
    TIMESTAMPS = %w[created_at updated_at invalidated_at].freeze
    PROFILE = { "provider" => "xenova-transformers", "model" => "all-MiniLM-L6-v2", "dimension" => 384, "distance" => "cosine", "schema_version" => 1 }.freeze

    def self.backup!(database, path, validator: nil)
      database.extension(:pg_array, :pg_json)
      output = nil
      database.transaction(isolation: :repeatable, read_only: true) do
        verify_target!(database)
        tables = TABLE_COLUMNS.to_h do |table, columns|
          projection = columns.map do |column|
            if TIMESTAMPS.include?(column)
              Sequel.function(:to_char, Sequel.identifier(column), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"').as(column.to_sym)
            elsif %w[embedding provenance worker_state].include?(column)
              Sequel.cast(Sequel.identifier(column), :text).as(column.to_sym)
            else
              column.to_sym
            end
          end
          order = table == "wagglebot_memories" ? :id : (table == "wagglebot_schema_migrations" ? :filename : :provider)
          rows = database[table.to_sym].select(*projection).order(order).all.map do |row|
            row.to_h.transform_keys(&:to_s)
          end
          rows.each do |row|
            %w[embedding provenance worker_state].each { |key| row[key] = JSON.parse(row[key]) if row.key?(key) }
            row["review_after"] = row["review_after"]&.iso8601 if row.key?("review_after")
          end
          [table, rows]
        end
        snapshot = { "schemaVersion" => 1, "embeddingProfileId" => PROFILE_ID, "migrationManifest" => manifest, "tables" => tables }
        output = validate!(JSON.generate(snapshot), scan: false, validator: validator)
      end
      # O_EXCL rejects existing files and dangling symlinks without following them.
      File.open(path, File::WRONLY | File::CREAT | File::EXCL, 0o600) { |file| file.write(JSON.generate(output) + "\n") }
      counts(output)
    rescue StandardError
      raise Error, "snapshot backup failed", cause: nil
    end

    def self.restore!(database, path, validator: nil)
      snapshot = validate!(File.binread(path), scan: true, validator: validator)
      database.extension(:pg_array, :pg_json)
      database.transaction do
        # Coordinate with worker mutations and prevent concurrent operator/migration changes.
        database.run("LOCK TABLE wagglebot_schema_migrations, wagglebot_memory_schema_metadata, wagglebot_memories IN EXCLUSIVE MODE")
        database[:wagglebot_memory_schema_metadata].for_update.all
        verify_target!(database)
        database[:wagglebot_memories].delete
        database[:wagglebot_memory_schema_metadata].delete
        %w[wagglebot_memory_schema_metadata wagglebot_memories].each do |table|
          columns = TABLE_COLUMNS.fetch(table)
          statement = database[table.to_sym].prepare(:insert, :"snapshot_insert_#{table}", columns.to_h { |column| [column.to_sym, :"$#{column}"] })
          snapshot.fetch("tables").fetch(table).each do |row|
            values = columns.to_h do |column|
              value = row.fetch(column)
              value = "[#{value.join(',')}]" if column == "embedding"
              value = Sequel.pg_array(value, :text) if %w[scopes tags].include?(column)
              value = Sequel.pg_jsonb(value) if %w[provenance worker_state].include?(column)
              [column.to_sym, value]
            end
            statement.call(values)
          end
        end
      end
      counts(snapshot)
    rescue StandardError
      raise Error, "snapshot restore failed", cause: nil
    end

    def self.manifest
      JSON.parse(File.read(Database::MANIFEST_PATH))
    end

    def self.verify_target!(database)
      Database.check!(database)
      raise Error unless manifest == Database.expected_manifest(Database::MIGRATION_DIRECTORY)
      metadata = database[:wagglebot_memory_schema_metadata].select(*PROFILE.keys.map(&:to_sym)).all
      raise Error unless metadata.length == 1 && metadata.first.transform_keys(&:to_s) == PROFILE
    end

    def self.validate!(bytes, scan:, validator: nil)
      normalized = if validator
        validator.call(bytes, scan: scan)
      else
        command = ["bun", VALIDATOR]
        command << "--scan" if scan
        stdout, _stderr, status = Open3.capture3(*command, stdin_data: bytes)
        raise Error unless status.success?
        stdout
      end
      snapshot = JSON.parse(normalized)
      exact_keys!(snapshot, %w[schemaVersion embeddingProfileId migrationManifest tables])
      raise Error unless snapshot["schemaVersion"] == 1 && snapshot["embeddingProfileId"] == PROFILE_ID
      raise Error unless snapshot["migrationManifest"] == manifest
      tables = snapshot.fetch("tables")
      exact_keys!(tables, TABLE_COLUMNS.keys)
      TABLE_COLUMNS.each do |table, columns|
        rows = tables.fetch(table)
        raise Error unless rows.is_a?(Array)
        rows.each do |row|
          exact_keys!(row, columns)
          row.each { |column, value| validate_value!(column, value) }
        end
      end
      metadata = tables.fetch("wagglebot_memory_schema_metadata")
      raise Error unless metadata.length == 1 && PROFILE.all? { |key, value| metadata.first[key] == value }
      history = tables.fetch("wagglebot_schema_migrations").map { |row| row.fetch("filename") }
      raise Error unless history == manifest.fetch("migrations")
      memories = tables.fetch("wagglebot_memories")
      %w[id canonical_key].each { |column| raise Error unless memories.map { |row| row[column] }.uniq.length == memories.length }
      snapshot
    rescue StandardError
      raise Error, "snapshot validation failed", cause: nil
    end

    def self.exact_keys!(object, keys)
      raise Error unless object.is_a?(Hash) && object.keys.sort == keys.sort
    end

    def self.validate_value!(column, value)
      valid = case column
      when "embedding"
        value.is_a?(Array) && value.length == 384 && value.all? { |number| number.is_a?(Numeric) && number.finite? }
      when "tags", "scopes"
        value.is_a?(Array) && value.all? { |item| item.is_a?(String) }
      when "provenance"
        value.is_a?(Array) && value.all? { |item| item.is_a?(Hash) }
      when "worker_state"
        value.is_a?(Hash)
      when "dimension", "schema_version", "provenance_count"
        value.is_a?(Integer) && value >= 0
      when "confidence"
        value.is_a?(Numeric) && value.finite? && [0, 0.5, 1].include?(value)
      when "active", "wake"
        value == true || value == false
      when *TIMESTAMPS
        (column == "invalidated_at" && value.nil?) || (value.is_a?(String) && value.match?(/\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z\z/) && Time.iso8601(value))
      when "review_after"
        value.nil? || (value.is_a?(String) && value.match?(/\A\d{4}-\d{2}-\d{2}\z/) && Date.iso8601(value))
      when "supersedes", "superseded_by", "invalidation_reason"
        value.nil? || value.is_a?(String)
      else
        value.is_a?(String)
      end
      raise Error unless valid
    end

    def self.counts(snapshot)
      { memories: snapshot.fetch("tables").fetch("wagglebot_memories").length, metadata: 1, migrations: snapshot.fetch("tables").fetch("wagglebot_schema_migrations").length }
    end
  end
end
