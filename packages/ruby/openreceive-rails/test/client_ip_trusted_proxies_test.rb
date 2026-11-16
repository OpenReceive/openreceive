# frozen_string_literal: true

# Whose address a checkout is attributed to, and so whose per-IP limit it
# counts against, for every way a request can reach a Rails app.
#
# The address that connected decides. One of the app's trusted proxies
# (config.action_dispatch.trusted_proxies, or Rails' private ranges when the
# app sets none) is answered with the client it forwarded. Any other address
# is the client itself, whatever X-Forwarded-For, Client-Ip or Forwarded say.
#
# Two defaults got this wrong. Rack's Request#ip never reads the app's trusted
# proxies, so a host that listed its public proxy, as Rails documents, still
# had every payer attributed to the proxy: one shared limit for the whole
# site. Rails' remote_ip alone reads them, but takes a forwarded header's word
# from anyone, so a client that connects directly picks its own address.
#
# Each test boots a real application and sends its checkouts through the whole
# middleware stack, in its own process: a Rails application initializes once.

require "minitest/autorun"
require "json"
require "open3"
require "rbconfig"
require "tmpdir"

class OpenReceiveClientIpTrustedProxiesTest < Minitest::Test
  CLIENT = "203.0.113.9"
  # A proxy with a public address: a cloud load balancer, a CDN.
  PROXY = "198.51.100.20"
  # The app's own reverse proxy, on a private address.
  PRIVATE_HOP = "10.0.0.5"
  # A client that connects straight to the app, and the address it would
  # like to be taken for.
  DIRECT = "203.0.113.50"
  FORGED = "192.0.2.99"

  BOOT = <<~'RUBY'
    require "json"
    require "ipaddr"
    require "logger"
    require "rack/mock"
    require "rails"
    require "action_controller/railtie"
    require "openreceive/rails"

    class ClientIpApp < Rails::Application
      config.root = ENV.fetch("APP_ROOT")
      config.eager_load = false
      config.secret_key_base = "x" * 64
      config.logger = Logger.new(IO::NULL)
      unless ENV["TRUSTED_PROXY"].to_s.empty?
        config.action_dispatch.trusted_proxies =
          ActionDispatch::RemoteIp::TRUSTED_PROXIES + [IPAddr.new(ENV["TRUSTED_PROXY"])]
      end
    end

    class Wallet
      def make_invoice(request)
        now = Time.now.to_i
        { "invoice" => "ln-client-ip", "payment_hash" => "ab" * 32,
          "amount_msats" => request.fetch("amount_msats"),
          "created_at" => now, "expires_at" => now + request.fetch("expiry", 600) }
      end

      def list_transactions(_request)
        { "transactions" => [] }
      end
    end

    stamped = []
    OpenReceive.configure do |config|
      config.authorize = ->(_context) { true }
      config.nwc_client = Wallet.new
      config.resolve_checkout = ->(**_context) { { "amount" => { "sats" => 1 } } }
      config.on_checkout_created = ->(client_ip: nil, **_payment) { stamped << client_ip }
      config.on_paid = ->(_settlement) {}
      config.opportunistic_reconcile = false
      unless ENV["CLIENT_IP_HEADER"].to_s.empty?
        config.client_ip = ->(request) { request.get_header(ENV["CLIENT_IP_HEADER"]) }
      end
    end
    Rails.application.initialize!
    Rails.application.routes.draw { mount OpenReceive::Engine => "/openreceive" }

    results = JSON.parse(ENV.fetch("REQUESTS")).each_with_index.map do |headers, index|
      env = Rack::MockRequest.env_for(
        "/openreceive/checkouts",
        { :method => "POST", :input => JSON.generate("reference" => "order-#{index}"),
          "CONTENT_TYPE" => "application/json" }.merge(headers)
      )
      rack_ip = Rack::Request.new(env.dup).ip
      stamped.clear
      status, _headers, body = Rails.application.call(env)
      body.close if body.respond_to?(:close)
      { "status" => status, "client_ip" => stamped.first, "rack_ip" => rack_ip }
    end
    puts JSON.generate(results)
  RUBY

  def test_a_client_that_connects_directly_cannot_choose_its_address
    forged = [
      { "HTTP_X_FORWARDED_FOR" => FORGED },
      { "HTTP_CLIENT_IP" => FORGED },
      { "HTTP_FORWARDED" => "for=#{FORGED}" },
      { "HTTP_X_FORWARDED_FOR" => "#{FORGED}, #{PRIVATE_HOP}" },
      {}
    ].map { |headers| headers.merge("REMOTE_ADDR" => DIRECT) }
    # With no proxy at all, and at an origin reached past its listed proxy.
    [nil, PROXY].each do |trusted_proxy|
      checkouts(forged, trusted_proxy: trusted_proxy).each_with_index do |result, index|
        assert_equal [201, DIRECT], result.values_at("status", "client_ip"),
                     "#{forged[index].inspect} with trusted proxy #{trusted_proxy.inspect}"
      end
    end
  end

  def test_a_listed_public_proxy_attributes_the_checkout_to_the_client
    through_listed_proxy = [
      # One hop: the proxy connects to the app.
      { "REMOTE_ADDR" => PROXY, "HTTP_X_FORWARDED_FOR" => CLIENT },
      # Two hops: the proxy, then the app's own reverse proxy.
      { "REMOTE_ADDR" => PRIVATE_HOP, "HTTP_X_FORWARDED_FOR" => "#{CLIENT}, #{PROXY}" },
      { "REMOTE_ADDR" => PROXY, "HTTP_X_FORWARDED_FOR" => "#{CLIENT}, #{PROXY}" },
      # What the client put in the header itself is not the answer.
      { "REMOTE_ADDR" => PROXY, "HTTP_X_FORWARDED_FOR" => "#{FORGED}, #{CLIENT}" }
    ]
    checkouts(through_listed_proxy, trusted_proxy: PROXY).each_with_index do |result, index|
      assert_equal [201, CLIENT], result.values_at("status", "client_ip"), through_listed_proxy[index].inspect
      # Rack still answers with the proxy; the engine no longer does.
      assert_equal PROXY, result.fetch("rack_ip"), through_listed_proxy[index].inspect
    end
  end

  def test_an_unlisted_public_proxy_is_counted_as_the_client
    through_unlisted_proxy = [
      # As the address that connected.
      { "REMOTE_ADDR" => PROXY, "HTTP_X_FORWARDED_FOR" => CLIENT },
      { "REMOTE_ADDR" => PROXY, "HTTP_X_FORWARDED_FOR" => "#{CLIENT}, #{PROXY}" },
      # Behind the app's own reverse proxy.
      { "REMOTE_ADDR" => PRIVATE_HOP, "HTTP_X_FORWARDED_FOR" => "#{CLIENT}, #{PROXY}" }
    ]
    checkouts(through_unlisted_proxy, trusted_proxy: nil).each_with_index do |result, index|
      assert_equal [201, PROXY], result.values_at("status", "client_ip"), through_unlisted_proxy[index].inspect
      # Attributed as Rack would.
      assert_equal result.fetch("rack_ip"), result.fetch("client_ip"), through_unlisted_proxy[index].inspect
    end
  end

  def test_a_private_proxy_needs_no_listing
    # It appended the client after whatever the client sent.
    request = { "REMOTE_ADDR" => PRIVATE_HOP, "HTTP_X_FORWARDED_FOR" => "#{FORGED}, #{CLIENT}" }
    result = checkouts([request], trusted_proxy: nil).first
    assert_equal [201, CLIENT], result.values_at("status", "client_ip")
  end

  def test_the_hosts_own_client_ip_still_wins
    requests = [PROXY, DIRECT].map do |remote_addr|
      { "REMOTE_ADDR" => remote_addr, "HTTP_X_FORWARDED_FOR" => CLIENT, "HTTP_CF_CONNECTING_IP" => "192.0.2.77" }
    end
    checkouts(requests, trusted_proxy: PROXY, client_ip_header: "HTTP_CF_CONNECTING_IP").each do |result|
      assert_equal [201, "192.0.2.77"], result.values_at("status", "client_ip")
    end
  end

  private

  # One booted application, one checkout per request (each a Hash of Rack env
  # entries); what each was attributed to, beside Rack's own answer.
  def checkouts(requests, trusted_proxy:, client_ip_header: nil)
    Dir.mktmpdir do |root|
      env = {
        "APP_ROOT" => root,
        "RAILS_ENV" => "production",
        "TRUSTED_PROXY" => trusted_proxy.to_s,
        "CLIENT_IP_HEADER" => client_ip_header.to_s,
        "REQUESTS" => JSON.generate(requests)
      }
      includes = $LOAD_PATH.grep(%r{packages/ruby/[^/]+/lib\z}).flat_map { |dir| ["-I", dir] }
      out, err, status = Open3.capture3(env, RbConfig.ruby, *includes, "-e", BOOT)
      assert status.success?, "boot failed:\n#{err}"
      results = JSON.parse(out.lines.last)
      assert_equal requests.length, results.length
      results
    end
  end
end
