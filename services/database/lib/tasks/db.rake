require "json"
require "time"
require_relative "../database"
require_relative "../snapshot"

namespace :db do
  desc "Export a scoped, protected JSON snapshot to a new file"
  task :backup, [:path] do |_task, arguments|
    begin
      result = Database::Snapshot.backup!(Database.connection!, arguments[:path])
      puts "snapshot backup: #{result[:memories]} memories, #{result[:metadata]} metadata, #{result[:migrations]} migrations"
    rescue StandardError
      abort "snapshot backup failed"
    end
  end

  desc "Restore a validated scoped JSON snapshot; stop all memory workers and drains first"
  task :restore, [:path] do |_task, arguments|
    begin
      result = Database::Snapshot.restore!(Database.connection!, arguments[:path])
      puts "snapshot restore: #{result[:memories]} memories, #{result[:metadata]} metadata, #{result[:migrations]} migrations"
    rescue StandardError
      abort "snapshot restore failed"
    end
  end

  desc "Create a timestamped reversible migration"
  task :generate, [:description] do |_task, arguments|
    filename = Database.generate_migration!(arguments[:description])
    puts filename
  end

  desc "Apply pending migrations and verify the shipped manifest"
  task :migrate do
    database = Database.connection!
    Database.migrate!(database)
    Database.check!(database)
  end

  desc "Roll back to an explicit 14-digit migration version"
  task :rollback, [:version] do |_task, arguments|
    version = Database.migration_version!(arguments[:version])
    database = Database.connection!
    Database.rollback!(database, version)
  end

  desc "Report applied and pending migrations"
  task :status do
    database = Database.connection!
    Database.status(database).each { |status| puts status }
  end

  desc "Compare database migration history with the shipped manifest"
  task :check do
    Database.check!(Database.connection!)
  end

  namespace :schema do
    desc "Export application schema with pg_dump"
    task :dump do
      Database.dump_schema!(Database.connection!)
    end
  end
end
