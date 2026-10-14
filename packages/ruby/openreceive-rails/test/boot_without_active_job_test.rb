# frozen_string_literal: true

# A host that leaves out ActiveJob (`rails new --minimal`, or an app that
# requires only the railties it uses) must still boot in production. The
# engine's ReconcileJob subclasses ActiveJob::Base, and eager loading used to
# load it anyway: the boot, and `bin/rails generate openreceive:install`, stopped
# with `uninitialized constant OpenReceive::ActiveJob`.
#
# Each boot runs in its own process: a Rails application initializes once.

require "minitest/autorun"
require "open3"
require "rbconfig"
require "tmpdir"

class OpenReceiveBootWithoutActiveJobTest < Minitest::Test
  BOOT = <<~RUBY
    require "rails"
    require "active_record/railtie"
    require "action_controller/railtie"
    require "active_job/railtie" if ENV["WITH_ACTIVE_JOB"] == "1"
    require "openreceive/rails"

    class BootApp < Rails::Application
      config.root = ENV.fetch("APP_ROOT")
      config.eager_load = true
      config.secret_key_base = "x" * 64
      config.logger = Logger.new(IO::NULL)
    end
    Rails.application.initialize!
    puts OpenReceive.const_defined?(:ReconcileJob) ? "job" : "no job"
  RUBY

  def test_an_eager_loaded_host_without_active_job_boots
    assert_equal "no job", boot(with_active_job: false)
  end

  def test_an_eager_loaded_host_with_active_job_still_loads_the_job
    assert_equal "job", boot(with_active_job: true)
  end

  private

  def boot(with_active_job:)
    Dir.mktmpdir do |root|
      env = {
        "APP_ROOT" => root,
        "RAILS_ENV" => "production",
        "DATABASE_URL" => "sqlite3::memory:",
        "WITH_ACTIVE_JOB" => with_active_job ? "1" : "0"
      }
      includes = $LOAD_PATH.grep(%r{packages/ruby/[^/]+/lib\z}).flat_map { |dir| ["-I", dir] }
      out, err, status = Open3.capture3(env, RbConfig.ruby, *includes, "-e", BOOT)
      assert status.success?, "boot failed:\n#{err}"
      out.strip
    end
  end
end
