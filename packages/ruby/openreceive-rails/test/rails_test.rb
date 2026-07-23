# frozen_string_literal: true

require "minitest/autorun"
require "openreceive/rails"

class StorageFreeRailsConfigTest < Minitest::Test
  def test_configuration_has_no_store_or_namespace
    config = OpenReceive::Configuration.new
    refute_respond_to config, :store
    refute_respond_to config, :namespace
    assert_respond_to config, :on_checkout_created
    assert_respond_to config, :token_keys
  end
end
