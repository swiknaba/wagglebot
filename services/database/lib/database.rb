require "json"
require "open3"

module Database
  class ConfigurationError < StandardError; end

  ROOT = File.expand_path("..", __dir__)
  MIGRATION_DIRECTORY = File.join(ROOT, "db", "migrations")
  MANIFEST_PATH = File.join(ROOT, "migration-version.json")
  APPLICATION_TABLES = %w[
    wagglebot_memories
    wagglebot_memory_schema_metadata
    wagglebot_schema_migrations
  ].freeze

  def self.connection!(environment: ENV)
    database_url = environment.fetch("DATABASE_URL", "").strip
    raise ConfigurationError, "DATABASE_URL is required" if database_url.empty?

    require "sequel"
    Sequel.connect(database_url, max_connections: 1)
  end

  def self.expected_manifest(migration_directory)
    migrations = Dir.children(migration_directory)
      .select { |name| name.match?(/\A\d{14}_.+\.rb\z/) }
      .sort

    {
      "latest" => migrations.last&.slice(0, 14),
      "migrations" => migrations,
    }
  end

  def self.migration_version!(version)
    return version if version.is_a?(String) && version.match?(/\A\d{14}\z/)

    raise ConfigurationError, "rollback requires a 14-digit migration version"
  end

  def self.generate_migration!(
    description,
    now: Time.now.utc,
    migration_directory: MIGRATION_DIRECTORY,
    manifest_path: MANIFEST_PATH
  )
    slug = description.to_s.downcase.gsub(/[^a-z0-9]+/, "_").gsub(/\A_|_\z/, "")
    raise ConfigurationError, "migration description is required" if slug.empty?

    Dir.mkdir(File.dirname(migration_directory)) unless Dir.exist?(File.dirname(migration_directory))
    Dir.mkdir(migration_directory) unless Dir.exist?(migration_directory)
    filename = "#{now.strftime("%Y%m%d%H%M%S")}_#{slug}.rb"
    path = File.join(migration_directory, filename)
    raise ConfigurationError, "migration already exists" if File.exist?(path)

    File.write(path, <<~RUBY)
      Sequel.migration do
        up do
        end

        down do
        end
      end
    RUBY
    write_manifest!(migration_directory: migration_directory, manifest_path: manifest_path)
    filename
  end

  def self.migrate!(database)
    load_migrator!
    Sequel::Migrator.run(
      database,
      MIGRATION_DIRECTORY,
      table: :wagglebot_schema_migrations,
      use_advisory_lock: true,
    )
  end

  def self.rollback!(database, version)
    load_migrator!
    target_version = migration_version!(version)
    Sequel::Migrator.run(
      database,
      MIGRATION_DIRECTORY,
      table: :wagglebot_schema_migrations,
      target: target_version.to_i,
      use_advisory_lock: true,
    )
  end

  def self.status(database)
    expected_manifest(MIGRATION_DIRECTORY).fetch("migrations").map do |filename|
      database[:wagglebot_schema_migrations].where(filename: filename).count.positive? ? "up #{filename}" : "down #{filename}"
    end
  end

  def self.check!(database)
    expected = expected_manifest(MIGRATION_DIRECTORY).fetch("migrations")
    actual = database[:wagglebot_schema_migrations].order(:filename).select_map(:filename)
    return true if actual == expected

    raise ConfigurationError, "database migrations do not match the shipped manifest"
  end

  def self.dump_schema!(database, output_path: File.join(ROOT, "schema.sql"), pg_dump: ENV.fetch("PG_DUMP", "pg_dump"))
    options = database.opts
    command = [
      pg_dump,
      "--schema-only",
      "--no-owner",
      "--no-privileges",
      "--no-tablespaces",
      "--restrict-key=wagglebotschema",
      *APPLICATION_TABLES.map { |table| "--table=#{table}" },
    ]
    command << "--host=#{options[:host]}" if options[:host]
    command << "--port=#{options[:port]}" if options[:port]
    command << "--username=#{options[:user]}" if options[:user]
    command << options.fetch(:database)

    environment = {}
    environment["PGPASSWORD"] = options[:password] if options[:password]
    environment["PGSSLMODE"] = options[:sslmode].to_s if options[:sslmode]
    environment["PGSSLROOTCERT"] = options[:sslrootcert] if options[:sslrootcert]
    schema, _stderr, status = Open3.capture3(environment, *command)
    raise ConfigurationError, "pg_dump failed" unless status.success?

    File.write(output_path, schema)
  end

  def self.load_migrator!
    require "sequel/extensions/migration"
  end

  def self.write_manifest!(migration_directory: MIGRATION_DIRECTORY, manifest_path: MANIFEST_PATH)
    File.write(manifest_path, JSON.pretty_generate(expected_manifest(migration_directory)) + "\n")
  end
end
