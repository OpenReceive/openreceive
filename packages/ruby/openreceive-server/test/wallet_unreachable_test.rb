# frozen_string_literal: true

# A wallet whose relay cannot be reached at start-up does not stop the
# service: it starts, logs one line, answers the retryable 503
# WALLET_UNAVAILABLE, and the first wallet call after the wait (1 s, doubling
# to 60 s) checks again. A wallet that is wrong still refuses, at start-up and
# on a later check. The Node stack's createRetryingBoot behavior.

require "minitest/autorun"
require "json"
require "logger"
require "stringio"
require "openreceive/server"

class WalletUnreachableTest < Minitest::Test
  RECEIVE_ONLY_HINT = "Use a receive-only NWC connection"

  # Shaped like nwc-ruby's NotSentError: the class the gem raises when a relay
  # fails before the request is written. The engine reads the class name.
  class NotSentError < StandardError; end

  CONNECT_FAILURE = "not sent: relay relay.test failed before the request was written " \
                    "(OpenSSL::SSL::SSLError: SSL_connect SYSCALL returned=5 errno=0 state=SSLv3/TLS write client hello)"

  # The wallet behind a relay the test switches off and on. While it is down
  # every call fails the way nwc-ruby fails a refused connection; `info`
  # replaces what the wallet advertises once it is back.
  class RelayWallet
    attr_accessor :down, :info
    attr_reader :preflights, :mints

    def initialize
      @down = true
      @info = { "methods" => %w[make_invoice list_transactions], "encryption" => %w[nip04] }
      @preflights = 0
      @mints = 0
    end

    def get_info
      @preflights += 1
      raise NotSentError, CONNECT_FAILURE if @down

      @info
    end

    def make_invoice(request)
      @mints += 1
      raise NotSentError, CONNECT_FAILURE if @down

      now = 1_700_000_000
      hash = @mints.to_s(16).rjust(64, "0")
      { "invoice" => "lnbc#{@mints}", "payment_hash" => hash,
        "amount_msats" => request.fetch("amount_msats"),
        "created_at" => now, "expires_at" => now + request.fetch("expiry", 600) }
    end

    def list_transactions(_request)
      raise NotSentError, CONNECT_FAILURE if @down

      { "transactions" => [] }
    end
  end

  def setup
    @now = 100.0
    @log = StringIO.new
    @logger = Logger.new(@log)
    @logger.formatter = ->(severity, _time, _progname, message) { "#{severity} #{message}\n" }
    @wallet = RelayWallet.new
  end

  def build_service(wallet = @wallet)
    OpenReceive::Server::Service.new(
      nwc_client: wallet, price_provider: false, swap_providers: [], env: {},
      clock: -> { 1_700_000_000 }, monotonic: -> { @now }, logger: @logger
    )
  end

  def rack_app(service)
    OpenReceive::Server::RackApp.new(
      service: service,
      authorize: ->(_context) { true },
      resolve_checkout: ->(**_context) { { "amount" => { "sats" => 1 } } },
      on_checkout_created: ->(**_payment) {},
      on_paid: ->(_payment) {}
    )
  end

  def checkout(app)
    status, _headers, body = app.call(
      "REQUEST_METHOD" => "POST", "PATH_INFO" => "/openreceive/checkouts", "QUERY_STRING" => "",
      "CONTENT_TYPE" => "application/json",
      "rack.input" => StringIO.new(JSON.generate("reference" => "order-42"))
    )
    [status, JSON.parse(body.join)]
  end

  def log_lines
    @log.string.lines.map(&:chomp).select { |line| line.include?("wallet.") }
  end

  def test_an_unreachable_wallet_at_start_up_starts_and_logs_what_happens_next
    service = build_service
    refute_nil service.wallet_pending
    assert_equal [
      "ERROR wallet.unreachable: OpenReceive could not reach the wallet's relay at start-up " \
      "(WalletUnreachableTest::NotSentError: #{CONNECT_FAILURE}). " \
      "The first checkout after 1 s tries again."
    ], log_lines
    refute_includes @log.string, RECEIVE_ONLY_HINT
  end

  def test_without_a_logger_the_line_goes_to_stderr
    _out, err = capture_io do
      OpenReceive::Server::Service.new(
        nwc_client: @wallet, price_provider: false, swap_providers: [], env: {}
      )
    end
    assert_includes err, "[openreceive] wallet.unreachable: OpenReceive could not reach the wallet's relay at start-up"
  end

  def test_checkouts_answer_the_retryable_503_then_are_served_once_the_relay_answers
    service = build_service
    app = rack_app(service)
    assert_equal 1, @wallet.preflights

    status, body = checkout(app)
    assert_equal 503, status
    assert_equal "WALLET_UNAVAILABLE", body["code"]
    assert_equal true, body["retryable"]
    assert_equal OpenReceive::Server::Service::WALLET_NOT_READY_MESSAGE, body["message"]
    # No retry before the wait is over, and nothing reached the wallet.
    @now += 0.9
    assert_equal 503, checkout(app).first
    assert_equal [1, 0], [@wallet.preflights, @wallet.mints]

    # The wait is over, the relay still refuses: one check, then twice the wait.
    @now += 0.1
    assert_equal 503, checkout(app).first
    assert_equal [2, 0], [@wallet.preflights, @wallet.mints]
    assert_match(/\AWARN wallet\.unreachable: OpenReceive still cannot reach the wallet's relay \(/, log_lines.last)
    assert log_lines.last.end_with?("The first checkout after 2 s tries again."), log_lines.last
    @now += 1.9
    assert_equal 503, checkout(app).first
    assert_equal 2, @wallet.preflights

    # The relay is back: the first checkout after the wait checks and is served.
    @wallet.down = false
    @now += 0.1
    status, body = checkout(app)
    assert_equal 201, status, body.inspect
    assert body.dig("checkout", "bolt11")
    assert_nil service.wallet_pending
    assert_equal "INFO wallet.reachable: OpenReceive reached the wallet's relay and the wallet check passed.",
                 log_lines.last
    # Checked once: later wallet calls go straight to the wallet.
    service.create_checkout("reference" => "order-43", "amount" => { "sats" => 1 })
    assert_equal [3, 2], [@wallet.preflights, @wallet.mints]
  end

  def test_the_wait_doubles_to_sixty_seconds
    service = build_service
    waits = []
    9.times do
      before = @wallet.preflights
      while @wallet.preflights == before
        @now += 0.5
        assert_raises(OpenReceive::Server::WalletFailureError) { service.ensure_wallet! }
      end
      waits << service.instance_variable_get(:@wallet_retry_seconds)
    end
    assert_equal [2, 4, 8, 16, 32, 60, 60, 60, 60], waits
  end

  def test_every_wallet_call_waits_for_the_check
    service = build_service
    attempt = { "payment_hash" => "a" * 64, "created_at" => 1_700_000_000 }
    error = assert_raises(OpenReceive::Server::WalletFailureError) do
      service.reconcile_payments("attempts" => [attempt])
    end
    assert_equal [503, "WALLET_UNAVAILABLE", true], [error.status, error.code, error.retryable]
    assert_raises(OpenReceive::Server::WalletFailureError) do
      service.create_checkout("reference" => "order-42", "amount" => { "sats" => 1 })
    end
    assert_equal [1, 0], [@wallet.preflights, @wallet.mints]
  end

  def test_a_later_check_refuses_a_spend_capable_wallet
    assert_later_check_refuses(
      { "methods" => %w[make_invoice list_transactions pay_invoice], "encryption" => %w[nip04] },
      "NOT receive-only"
    )
  end

  def test_a_later_check_refuses_a_wallet_that_cannot_receive
    assert_later_check_refuses({ "methods" => %w[make_invoice], "encryption" => %w[nip04] }, RECEIVE_ONLY_HINT)
  end

  def assert_later_check_refuses(info, refusal)
    service = build_service
    app = rack_app(service)
    @wallet.down = false
    @wallet.info = info
    @now += 1
    status, body = checkout(app)
    assert_equal [503, "WALLET_UNAVAILABLE"], [status, body["code"]]
    assert_equal 0, @wallet.mints
    refute_nil service.wallet_pending
    line = log_lines.last
    assert line.start_with?(
      "ERROR wallet.refused: OpenReceive reached the wallet's relay, but the wallet check failed"
    ), line
    assert_includes line, refusal
    assert line.end_with?("The first checkout after 2 s checks again."), line
    # The refusal holds until a check passes.
    assert_equal 503, checkout(app).first
    assert_equal 0, @wallet.mints
  end

  def test_a_wallet_that_is_wrong_still_refuses_at_start_up
    @wallet.down = false
    @wallet.info = { "methods" => %w[make_invoice list_transactions pay_invoice] }
    assert_raises(OpenReceive::Server::SpendCapableWalletError) { build_service }
    @wallet.info = { "methods" => %w[make_invoice], "encryption" => %w[nip04] }
    error = assert_raises(OpenReceive::Server::WalletPreflightError) { build_service }
    assert_includes error.message, RECEIVE_ONLY_HINT
  end

  # Shaped like nwc-ruby's InfoUnavailableError, a NotSentError whose relay
  # answered and holds no info event for the wallet: a wrong relay or pubkey.
  class InfoUnavailableError < NotSentError; end

  class NoInfoEventWallet < RelayWallet
    def get_info
      raise InfoUnavailableError, "wallet service published no info event (kind 13194) on relay relay.test"
    end
  end

  def test_an_answer_that_is_wrong_is_not_deferred
    error = assert_raises(OpenReceive::Server::WalletPreflightError) { build_service(NoInfoEventWallet.new) }
    assert_includes error.message, "could not read wallet info"
    assert_includes error.message, "no info event"
  end

  def test_a_malformed_code_still_fails_at_start_up
    assert_raises(OpenReceive::NwcUriParseError) do
      OpenReceive::NwcRubyReceiveClient.from_uri("nostr+walletconnect://not-a-pubkey?relay=wss://relay.test")
    end
    malformed = Class.new(RelayWallet) do
      def get_info
        OpenReceive.parse_nwc_uri("nostr+walletconnect://not-a-pubkey")
      end
    end
    assert_raises(OpenReceive::NwcUriParseError) { build_service(malformed.new) }
  end

  # Shaped like nwc-ruby's TimeoutError (sent, no reply in time) and
  # WalletServiceError (the wallet answered with an error code).
  class TimeoutError < StandardError; end

  class WalletServiceError < StandardError
    def code = "RESTRICTED"
  end

  def test_what_counts_as_unreachable
    unreachable = OpenReceive::Server::Service.method(:wallet_unreachable?)
    assert unreachable.call(NotSentError.new("not sent"))
    assert unreachable.call(Errno::ECONNREFUSED.new)
    assert unreachable.call(SocketError.new("getaddrinfo: Name or service not known"))
    assert unreachable.call(Timeout::Error.new("execution expired"))
    assert unreachable.call(TimeoutError.new("no response to get_info within 12s"))

    refute unreachable.call(InfoUnavailableError.new("no info event"))
    refute unreachable.call(RuntimeError.new("unexpected shape"))
    refute unreachable.call(WalletServiceError.new("RESTRICTED: not allowed"))
  end

  def test_concurrent_calls_share_one_check
    gate = Queue.new
    slow = Class.new(RelayWallet) do
      define_method(:get_info) do
        gate.pop if preflights >= 1
        super()
      end
    end.new
    service = build_service(slow)
    slow.down = false
    @now += 1
    threads = Array.new(4) { Thread.new { service.ensure_wallet! } }
    sleep 0.05
    gate << :go
    threads.each { |thread| thread.join(5) }
    assert_equal 2, slow.preflights
    assert_nil service.wallet_pending
  end
end
