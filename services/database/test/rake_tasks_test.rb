require "minitest/autorun"
require "open3"
require "rake"

Rake.application = Rake::Application.new
load File.expand_path("../Rakefile", __dir__)

class RakeTasksTest < Minitest::Test
  def test_exposes_only_the_documented_database_commands
    task_names = Rake::Task.tasks.map(&:name)

    %w[db:check db:generate db:migrate db:rollback db:schema:dump db:status].each do |task_name|
      assert_includes task_names, task_name
    end
    refute_includes task_names, "db:create"
    refute_includes task_names, "db:drop"
  end

  def test_rollback_rejects_a_missing_target_before_connecting
    _stdout, stderr, status = Open3.capture3("rake", "-f", "Rakefile", "db:rollback", chdir: File.expand_path("..", __dir__))

    refute status.success?
    assert_includes stderr, "rollback requires a 14-digit migration version"
    refute_includes stderr, "DATABASE_URL is required"
  end
end
