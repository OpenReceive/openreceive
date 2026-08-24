# frozen_string_literal: true

require "minitest/autorun"
require "json"
require "stringio"
require "securerandom"
require "openreceive/rails"
require "action_controller"

require_relative "../app/controllers/openreceive/application_controller"
require_relative "../app/controllers/openreceive/rates_controller"

# Minimal receive-only wallet so Configuration#request_handler can boot a Service.
class ControllerFakeWallet
  def make_invoice(request)
    now = Time.now.to_i
    { "invoice" => "ln-controller", "payment_hash" => "ab" * 32,
      "amount_msats" => request.fetch("amount_msats"),
      "created_at" => now, "expires_at" => now + request.fetch("expiry", 600) }
  end

  def list_transactions(_request)
    { "transactions" => [] }
  end
end

# Engine subclasses exercising the shared adapter plumbing through real action
# dispatch (rescue_from, around_action, openreceive_raw_body, openreceive_respond).
class OpenReceiveBoomController < OpenReceive::ApplicationController
  def boom
    raise "kaput internal detail"
  end
end

# Counts opportunistic-reconcile passes so a test can prove which routes claim
# the gate. Subclasses the real rates controller so its skip_around_action is
# the thing under test, not a re-declaration.
class OpenReceiveCountingRatesController < OpenReceive::RatesController
  class << self
    attr_accessor :passes
  end
  self.passes = 0

  private

  def openreceive_opportunistic_reconcile
    self.class.passes += 1
    super
  end
end

class OpenReceiveCountingEchoController < OpenReceive::ApplicationController
  class << self
    attr_accessor :passes
  end
  self.passes = 0

  def echo
    openreceive_respond(
      [200,
       { "content-type" => "application/json; charset=utf-8", "x-request-id" => openreceive_request_id },
       { "ok" => true }]
    )
  end

  private

  def openreceive_opportunistic_reconcile
    self.class.passes += 1
    super
  end
end

class OpenReceiveEchoController < OpenReceive::ApplicationController
  def echo
    openreceive_respond(
      [200,
       { "content-type" => "application/json; charset=utf-8", "x-request-id" => openreceive_request_id },
       { "bytes" => openreceive_raw_body.bytesize }]
    )
  end
end

class EngineControllerAdapterTest < Minitest::Test
  MAX_BODY_BYTES = OpenReceive::Server::RequestHandler::MAX_BODY_BYTES

  # rack.input double that records every read so tests can prove the body is
  # never slurped past the cap (mirrors the server gem's RecordingInput).
  class RecordingInput
    attr_reader :read_lengths

    def initialize(bytes)
      @io = StringIO.new(bytes)
      @read_lengths = []
    end

    def read(length = nil)
      @read_lengths << length
      @io.read(length)
    end

    def rewind
      @io.rewind
    end
  end

  def setup
    OpenReceive.reset_config!
    OpenReceive.configure do |config|
      config.authorize = ->(_context) { true }
      config.nwc_client = ControllerFakeWallet.new
      config.resolve_checkout = ->(**_context) { { "amount" => { "sats" => 1 } } }
      config.on_checkout_created = ->(**_payment) {}
      config.on_paid = ->(_settlement) {}
      config.opportunistic_reconcile = false
    end
  end

  def teardown
    OpenReceive.reset_config!
  end

  # JSON content type matters under real dispatch: it routes Rails' own body
  # access through raw_post (memoize + rewind) instead of form parsing, exactly
  # like the checkout clients' requests.
  def build_env(input, content_length: nil)
    env = {
      "REQUEST_METHOD" => "POST",
      "PATH_INFO" => "/openreceive/test",
      "SCRIPT_NAME" => "",
      "QUERY_STRING" => "",
      "SERVER_NAME" => "example.org",
      "SERVER_PORT" => "80",
      "rack.url_scheme" => "http",
      "rack.input" => input,
      "rack.errors" => StringIO.new,
      "CONTENT_TYPE" => "application/json"
    }
    env["CONTENT_LENGTH"] = content_length unless content_length.nil?
    env
  end

  def raw_body_for(env)
    controller = OpenReceive::ApplicationController.new
    controller.set_request!(ActionDispatch::Request.new(env))
    controller.send(:openreceive_raw_body)
  end

  def dispatch(controller_class, action, env)
    status, headers, body = controller_class.action(action).call(env)
    payload = +""
    body.each { |chunk| payload << chunk }
    [status, headers, JSON.parse(payload)]
  end

  # An over-declared Content-Length is rejected before a single byte is read
  # (mirrors RackApp#read_body and the JS readJsonBody declared-length check).
  def test_raw_body_rejects_an_over_declared_content_length_before_reading
    input = RecordingInput.new(JSON.generate("reference" => "rails-cap"))
    env = build_env(input, content_length: (MAX_BODY_BYTES + 1).to_s)
    assert_raises(OpenReceive::Server::PayloadTooLargeError) { raw_body_for(env) }
    assert_empty input.read_lengths, "the body must not be read when the declared length is over the cap"
  end

  # A body with no declared length (chunked) is read at most one byte past the
  # cap, never slurped whole.
  def test_raw_body_caps_undeclared_oversized_bodies
    input = RecordingInput.new("x" * (MAX_BODY_BYTES * 3))
    assert_raises(OpenReceive::Server::PayloadTooLargeError) { raw_body_for(build_env(input)) }
    assert_equal [MAX_BODY_BYTES + 1], input.read_lengths, "reads must be capped, never unbounded"
  end

  def test_raw_body_under_the_cap_flows_through_unchanged
    raw = JSON.generate("reference" => "rails-ok")
    assert_equal raw, raw_body_for(build_env(StringIO.new(raw), content_length: raw.bytesize.to_s))
  end

  # Through real action dispatch, an oversized body answers with the shared
  # 413 contract body via the engine's rescue_from — never a host HTML page.
  # Both cap branches: a declared Content-Length over the limit, and an
  # undeclared (chunked-style) body caught by the capped read.
  def test_oversized_body_answers_the_contract_413_through_dispatch
    oversized = JSON.generate("memo" => "x" * (MAX_BODY_BYTES * 2))
    [oversized.bytesize.to_s, nil].each do |content_length|
      env = build_env(StringIO.new(oversized), content_length: content_length)
      status, headers, body = dispatch(OpenReceiveEchoController, :echo, env)
      assert_equal 413, status, "content_length=#{content_length.inspect}"
      assert_equal "INVALID_REQUEST", body.fetch("code")
      assert_equal "Request body is too large.", body.fetch("message")
      assert_match(/\Areq_/, body.fetch("request_id"))
      assert_match(/\Areq_/, headers.fetch("x-request-id"))
    end

    ok_status, _ok_headers, ok_body = dispatch(
      OpenReceiveEchoController, :echo, build_env(StringIO.new("{}"), content_length: "2")
    )
    assert_equal 200, ok_status
    assert_equal 2, ok_body.fetch("bytes")
  end

  # An unexpected adapter-layer exception is redacted to the shared opaque 500
  # AND reported through Rails.error before the response goes on the wire.
  def test_adapter_exceptions_answer_the_contract_500_and_report_through_rails_error
    reports = []
    subscriber = Object.new
    subscriber.define_singleton_method(:report) do |error, handled:, severity:, context:, source: nil|
      reports << { error: error, handled: handled, severity: severity, context: context, source: source }
    end
    Rails.error.subscribe(subscriber)
    status, headers, body = dispatch(OpenReceiveBoomController, :boom, build_env(StringIO.new("")))
    assert_equal 500, status
    assert_equal "INTERNAL", body.fetch("code")
    assert_equal "Internal server error.", body.fetch("message")
    refute_includes JSON.generate(body), "kaput"
    assert_match(/\Areq_/, headers.fetch("x-request-id"))
    report = reports.find { |entry| entry[:error].is_a?(RuntimeError) }
    refute_nil report, "the swallowed exception must reach the Rails error reporter"
    assert_equal "kaput internal detail", report[:error].message
    assert_equal "openreceive", report[:source]
    assert_equal true, report[:handled]
  ensure
    Rails.error.unsubscribe(subscriber) if Rails.error.respond_to?(:unsubscribe)
  end

  # Unauthenticated GET /rates must not consume the wallet-scan budget:
  # crawlers and health checks hit it freely. The JS handler returns before its
  # opportunistic pass for route.kind "rates"; the engine skips the filter.
  def test_rates_never_claims_the_reconcile_gate_but_payment_routes_do
    OpenReceiveCountingRatesController.passes = 0
    OpenReceiveCountingEchoController.passes = 0

    rates_env = build_env(StringIO.new(""))
    rates_env["REQUEST_METHOD"] = "GET"
    rates_env["PATH_INFO"] = "/openreceive/rates"
    dispatch(OpenReceiveCountingRatesController, :index, rates_env)
    assert_equal 0, OpenReceiveCountingRatesController.passes,
                 "GET /rates must not run the opportunistic reconcile pass"

    dispatch(OpenReceiveCountingEchoController, :echo, build_env(StringIO.new("{}"), content_length: "2"))
    assert_equal 1, OpenReceiveCountingEchoController.passes,
                 "a payment route still runs exactly one pass"
  end
end
