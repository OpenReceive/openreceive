# frozen_string_literal: true

# The engine's DEFAULT wallet client, driven against the real nwc-ruby gem.
#
# Every other Ruby suite drives a hand-written fake mirroring nwc-ruby's API
# (FakeNwcRubyClient, ReceiveOnlyNwcRubyClient), which is the right way to test
# the adapter's translation — but it means the whole suite stayed green while
# openreceive-rails shipped without declaring nwc-ruby at all, and the first
# checkout on a stock install answered "Install nwc-ruby or configure
# nwc_client." So this file uses no fake: it builds the client the quickstart
# reader gets, from a connection URI, through the same code path the engine's
# production boot preflight runs.
#
# Constructing a NwcRuby::Client does not talk to the relay, so this is offline;
# anything past that (get_info, make_invoice) is the live smoke test's job.

require "minitest/autorun"
require "openreceive/rails"

class OpenReceiveDefaultNwcClientTest < Minitest::Test
  # Well-formed but unroutable: a real 32-byte pubkey/secret pair and a relay
  # nothing listens on. Construction parses it; only a wallet call would dial.
  CONNECTION_URI = "nostr+walletconnect://#{'a' * 64}?relay=wss://relay.invalid&secret=#{'b' * 64}"

  def setup
    OpenReceive.reset_config!
    @previous_nwc_uri = ENV.delete("NWC_URI")
  end

  def teardown
    ENV["NWC_URI"] = @previous_nwc_uri unless @previous_nwc_uri.nil?
    OpenReceive.reset_config!
  end

  def test_a_connection_uri_alone_builds_the_real_nwc_ruby_client
    configure_quickstart { |config| config.nwc = CONNECTION_URI }

    # validate! is what the production boot preflight reaches through
    # (config.service -> validate! -> resolved_nwc_client), so a missing
    # nwc-ruby raises HERE, at deploy, rather than on the first checkout.
    assert OpenReceive.config.validate!

    client = OpenReceive.config.send(:resolved_nwc_client)
    assert_instance_of OpenReceive::NwcRubyReceiveClient, client
    # The wrapped object is the gem's own client, not a stand-in: this is the
    # assertion that fails when nwc-ruby is not installed.
    assert_instance_of ::NwcRuby::Client, client.instance_variable_get(:@client)
    # The adapter redacts the secret it was handed; nothing may echo it back.
    refute_includes client.redacted_connection_uri.to_s, "b" * 64
  end

  def test_nwc_uri_from_the_environment_takes_the_same_path
    ENV["NWC_URI"] = CONNECTION_URI
    configure_quickstart

    assert OpenReceive.config.validate!
    assert_instance_of(
      ::NwcRuby::Client,
      OpenReceive.config.send(:resolved_nwc_client).instance_variable_get(:@client)
    )
  end

  def test_an_injected_client_still_wins_over_the_default
    injected = Object.new
    def injected.make_invoice(_request) = {}
    configure_quickstart { |config| config.nwc_client = injected }

    assert_same injected, OpenReceive.config.send(:resolved_nwc_client)
  end

  def test_no_uri_and_no_client_fails_closed
    configure_quickstart

    error = assert_raises(OpenReceive::ConfigurationError) { OpenReceive.config.validate! }
    assert_includes error.message, "needs a receive-only NWC code"
    assert_includes error.message, "Set NWC_URI"
    assert_includes error.message, OpenReceive::NWC_CODE_HELP_URL
  end

  # Mirrors the JS formatInvalidNwcMessage framing: what is wrong, the parse
  # reason, and where to get a receive-only code — not a bare parse error.
  def test_an_invalid_uri_fails_closed_with_the_framed_help
    configure_quickstart { |config| config.nwc = "https://example.com" }

    error = assert_raises(OpenReceive::ConfigurationError) { OpenReceive.config.validate! }
    assert_includes error.message, "OpenReceive.config.nwc is set, but it is not a valid NWC code."
    assert_includes error.message, "Reason:"
    assert_includes error.message, OpenReceive::NWC_CODE_HELP_URL
  end

  def test_an_invalid_env_uri_names_the_environment_variable
    ENV["NWC_URI"] = "nostr+walletconnect://not-a-pubkey"
    configure_quickstart

    error = assert_raises(OpenReceive::ConfigurationError) { OpenReceive.config.validate! }
    assert_includes error.message, "NWC_URI is set, but it is not a valid NWC code."
  end

  private

  def configure_quickstart
    OpenReceive.configure do |config|
      config.authorize = ->(_request, _reference) { true }
      config.amount_for = ->(_reference) { 1_000 }
      config.on_paid = ->(_payment) {}
      yield(config) if block_given?
    end
  end
end
