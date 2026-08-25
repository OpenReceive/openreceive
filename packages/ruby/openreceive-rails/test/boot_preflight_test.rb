# frozen_string_literal: true

# Which production boots get the fail-closed wallet preflight, and which do not.
#
# `rails assets:precompile` inside an image build is a production boot by
# RAILS_ENV with no wallet secrets mounted — secrets arrive at deploy time — so
# preflighting there failed the BUILD, long before the deploy the check exists
# to protect. Following the quickstart on any container-built Rails app
# produced an image that could not be built, and the only lever was a
# host-invented flag guarding the whole initializer.

require "minitest/autorun"
require "openreceive/rails"

class OpenReceiveBootPreflightTest < Minitest::Test
  def setup
    OpenReceive.reset_config!
    @previous_dummy = ENV.delete("SECRET_KEY_BASE_DUMMY")
  end

  def teardown
    ENV["SECRET_KEY_BASE_DUMMY"] = @previous_dummy unless @previous_dummy.nil?
    ENV.delete("SECRET_KEY_BASE_DUMMY") if @previous_dummy.nil?
    OpenReceive.reset_config!
  end

  def test_an_ordinary_production_boot_is_preflighted
    assert_nil OpenReceive.preflight_skip_reason
    assert OpenReceive.eager_preflight?
    refute OpenReceive.asset_build?
  end

  def test_rails_own_dockerfile_convention_skips_the_preflight
    ENV["SECRET_KEY_BASE_DUMMY"] = "1"

    assert OpenReceive.asset_build?
    assert_equal "asset build", OpenReceive.preflight_skip_reason
    refute OpenReceive.eager_preflight?
  end

  def test_an_assets_precompile_rake_invocation_skips_the_preflight
    with_rake_tasks(["assets:precompile"]) do
      assert OpenReceive.asset_build?
      assert_equal "asset build", OpenReceive.preflight_skip_reason
    end
  end

  def test_a_serving_rake_task_is_not_an_asset_build
    with_rake_tasks(["openreceive:notifications"]) do
      refute OpenReceive.asset_build?
      assert OpenReceive.eager_preflight?
    end
  end

  def test_eager_preflight_false_is_the_documented_override
    OpenReceive.configure { |config| config.eager_preflight = false }

    assert_equal "config.eager_preflight = false", OpenReceive.preflight_skip_reason
    refute OpenReceive.eager_preflight?
    # The override is about the BOOT check only — it never disables the wallet
    # check itself, which still runs on the first request.
    refute OpenReceive.asset_build?
  end

  def test_eager_preflight_defaults_on
    assert_equal true, OpenReceive.config.eager_preflight
  end

  private

  # Stands in for a `rails <task>` invocation without loading rake into every
  # other suite: asset_build? asks Rake.application for its top-level tasks.
  def with_rake_tasks(tasks)
    require "rake"
    original = ::Rake.application.top_level_tasks.dup
    ::Rake.application.top_level_tasks.replace(tasks)
    yield
  ensure
    ::Rake.application.top_level_tasks.replace(original) unless original.nil?
  end
end
