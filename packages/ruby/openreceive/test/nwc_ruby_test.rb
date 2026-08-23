# frozen_string_literal: true

require "minitest/autorun"
require "openreceive/nwc_ruby"

# The engine speaks NIP-47 param names ("from", "until", "limit", ...); nwc-ruby
# declares them as keyword arguments, and spells the window `until_ts` because
# `until` is a Ruby keyword.
class NwcRubyReceiveClientParamsTest < Minitest::Test
  # Signature copied from nwc-ruby 0.2.4.
  class KeywordClient
    attr_reader :calls

    def initialize
      @calls = []
    end

    def make_invoice(amount:, description: nil, description_hash: nil, expiry: nil, metadata: nil)
      @calls << [:make_invoice, { amount: amount, description: description, description_hash: description_hash,
                                  expiry: expiry, metadata: metadata }.compact]
      { "invoice" => "lnbc1", "payment_hash" => "a" * 64, "amount" => amount, "created_at" => 1_730_000_000 }
    end

    def list_transactions(from: nil, until_ts: nil, limit: nil, offset: nil, unpaid: nil, type: nil)
      @calls << [:list_transactions, { from: from, until_ts: until_ts, limit: limit, offset: offset,
                                       unpaid: unpaid, type: type }.compact]
      { "transactions" => [] }
    end
  end

  def scan_request
    { "type" => "incoming", "limit" => 20, "offset" => 0, "from" => 1_730_000_000, "until" => 1_730_003_600 }
  end

  def test_nip47_until_maps_to_until_ts
    client = KeywordClient.new
    OpenReceive::NwcRubyReceiveClient.new(client: client).list_transactions(scan_request)

    method, params = client.calls.fetch(0)
    assert_equal :list_transactions, method
    assert_equal(
      { from: 1_730_000_000, until_ts: 1_730_003_600, limit: 20, offset: 0, type: "incoming" },
      params
    )
  end

  def test_make_invoice_keywords_pass_through_unrenamed
    client = KeywordClient.new
    invoice = OpenReceive::NwcRubyReceiveClient.new(client: client).make_invoice(
      "amount_msats" => 100_000, "description" => "coffee", "expiry" => 600
    )

    assert_equal [[:make_invoice, { amount: 100_000, description: "coffee", expiry: 600 }]], client.calls
    assert_equal "a" * 64, invoice["payment_hash"]
  end
end

class NwcRubyReceiveClientNotificationsTest < Minitest::Test
  # nwc-ruby yields this value object, not the NWC-02 wire hash: `type` plus
  # the raw `notification` object in `data`.
  class FakeNotification
    attr_reader :type, :data

    def initialize(type:, data:)
      @type = type
      @data = data
    end
  end

  # Mirrors nwc-ruby 0.2.4's listener: keyword-only, block required, and it
  # does not return until the subscription ends.
  class FakeNwcRubyClient
    attr_reader :subscribe_calls

    def initialize(notifications: [], result: :ended)
      @notifications = notifications
      @result = result
      @subscribe_calls = 0
    end

    def subscribe_to_notifications(since: Time.now.to_i, kinds: [23_196, 23_197], &block)
      raise ArgumentError, "block required" unless block

      @subscribe_calls += 1
      _ = [since, kinds]
      @notifications.each { |notification| block.call(notification) }
      @result
    end
  end

  def settled_payload(payment_hash)
    {
      "type" => "incoming", "state" => "settled", "invoice" => "lnbc1",
      "payment_hash" => payment_hash, "preimage" => "f" * 64,
      "amount" => 100_000, "fees_paid" => 0,
      "created_at" => 1_730_000_000, "settled_at" => 1_730_000_060
    }
  end

  def test_notification_object_becomes_the_nwc02_wire_shape_with_settlement_fields_intact
    hash = "a" * 64
    client = FakeNwcRubyClient.new(
      notifications: [FakeNotification.new(type: "payment_received", data: settled_payload(hash))]
    )
    adapter = OpenReceive::NwcRubyReceiveClient.new(client: client)

    seen = []
    assert_equal :ended, adapter.subscribe_notifications { |n| seen << n }

    assert_equal 1, seen.length
    assert_equal "payment_received", seen[0]["notification_type"]
    # The engine reads the payload exactly like a list_transactions row, so
    # the finality fields — not the preimage — must survive the translation.
    transaction = OpenReceive::Nwc.normalize_transaction(seen[0]["notification"])
    assert_equal "settled", OpenReceive::Settlement.status(transaction)
    assert_equal hash, transaction["payment_hash"]
    assert_equal 1_730_000_060, transaction["settled_at"]
  end

  def test_every_notification_type_is_forwarded_for_the_engine_to_filter
    client = FakeNwcRubyClient.new(
      notifications: [
        FakeNotification.new(type: "payment_sent", data: settled_payload("b" * 64)),
        FakeNotification.new(type: "payment_received", data: settled_payload("c" * 64))
      ]
    )
    adapter = OpenReceive::NwcRubyReceiveClient.new(client: client)

    seen = []
    adapter.subscribe_notifications { |n| seen << n }

    # NWC-02 subscriptions are not type-filtered; the engine's own handler
    # decides what settles, so the adapter forwards everything translated.
    assert_equal %w[payment_sent payment_received], seen.map { |n| n["notification_type"] }
    assert_equal "c" * 64, seen[1]["notification"]["payment_hash"]
  end
end
