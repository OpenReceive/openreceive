# frozen_string_literal: true

require "minitest/autorun"
require "openreceive/server"
require "openreceive/nwc_ruby"

class PreflightAdapterTest < Minitest::Test
  class ReceiveOnlyWallet
    def make_invoice(_request) = {}
    def list_transactions(_request) = { "transactions" => [] }
  end

  def build_service(wallet, **options)
    OpenReceive::Server::Service.new(nwc_client: wallet, clock: -> { 1000 }, **options)
  end

  def test_wrapped_client_without_get_info_boots_like_the_bare_client
    assert build_service(ReceiveOnlyWallet.new)
    assert build_service(OpenReceive::NwcRubyReceiveClient.new(client: ReceiveOnlyWallet.new))
  end

  def test_adapter_preflight_is_nil_when_the_wrapped_client_has_no_info_method
    adapter = OpenReceive::NwcRubyReceiveClient.new(client: ReceiveOnlyWallet.new)
    assert_nil adapter.preflight
  end
end
