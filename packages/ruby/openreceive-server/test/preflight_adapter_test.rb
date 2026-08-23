# frozen_string_literal: true

require "minitest/autorun"
require "openreceive/server"
require "openreceive/nwc_ruby"

class PreflightAdapterTest < Minitest::Test
  # A custom host client with no info method at all: nothing to preflight, so
  # it boots unchecked (the documented custom-adapter escape hatch).
  class BareWallet
    def make_invoice(_request) = {}
    def list_transactions(_request) = { "transactions" => [] }
  end

  # Mirrors nwc-ruby 0.2.4, which always exposes get_info; the adapter feeds
  # its NIP-47 info result into the boot preflight.
  class ReceiveOnlyNwcRubyClient
    def make_invoice(**_params) = {}
    def list_transactions(**_params) = { "transactions" => [] }

    def get_info
      { "alias" => "test", "methods" => %w[get_info make_invoice list_transactions lookup_invoice] }
    end
  end

  def build_service(wallet, **options)
    OpenReceive::Server::Service.new(nwc_client: wallet, clock: -> { 1000 }, **options)
  end

  def test_bare_client_without_an_info_method_boots_unchecked
    assert build_service(BareWallet.new)
  end

  def test_adapter_preflight_feeds_the_wrapped_get_info_to_the_boot_check
    adapter = OpenReceive::NwcRubyReceiveClient.new(client: ReceiveOnlyNwcRubyClient.new)
    assert_equal %w[get_info make_invoice list_transactions lookup_invoice], adapter.preflight["methods"]
    assert build_service(adapter)
  end
end
