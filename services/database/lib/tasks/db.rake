require "json"
require "time"
require_relative "../database"

namespace :db do
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
