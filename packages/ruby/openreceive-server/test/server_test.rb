# frozen_string_literal: true

require "json"
require "stringio"
require "digest"
require "minitest/autorun"
require "openreceive/server"

class OpenReceiveServerTest < Minitest::Test
  FIXED_NOW = 1_000_000

  # Raw NWC client fake (wrapped by the service in NwcRubyReceiveClient). Receive-only: it has
  # make_invoice + list_transactions and NO spend method. `auto_settle:` makes list_transactions
  # report every issued invoice as settled; `transactions:` supplies an explicit raw page.
  class FakeWallet
    attr_reader :make_invoice_calls, :list_transactions_calls

    def initialize(auto_settle: false, transactions: nil)
      @auto_settle = auto_settle
      @transactions = transactions
      @issued = []
      @make_invoice_calls = []
      @list_transactions_calls = []
    end

    def make_invoice(params)
      # Guard on a string key FIRST (like the core FakeNwcRubyClient): NwcRubyReceiveClient tries a
      # keyword call first, which arrives here symbol-keyed; failing fast before mutating state keeps
      # that discarded attempt from recording, so only the string-keyed retry is observed.
      amount = params.fetch("amount")
      index = @issued.length + 1
      invoice = "lnbc-fake-#{index}"
      payment_hash = format("%064x", index)
      @issued << { invoice: invoice, payment_hash: payment_hash, amount: amount }
      @make_invoice_calls << params
      { "invoice" => invoice, "payment_hash" => payment_hash, "amount" => amount }
    end

    def list_transactions(params)
      params.fetch("type") # guard (see make_invoice)
      @list_transactions_calls << params
      return { "transactions" => @transactions } unless @transactions.nil?
      return { "transactions" => [] } unless @auto_settle

      transactions = @issued.map do |issued|
        {
          "type" => "incoming",
          "invoice" => issued[:invoice],
          "payment_hash" => issued[:payment_hash],
          "amount" => issued[:amount],
          "state" => "settled",
          "settled_at" => FIXED_NOW + 100
        }
      end
      { "transactions" => transactions }
    end
  end

  # Injected static price provider (stands in for the scaffolded live feed).
  class StaticPriceProvider
    def initialize(price, source: "static-test")
      @price = price
      @source = source
    end

    def btc_fiat_price(_currency)
      @price
    end

    def source
      @source
    end
  end

  def build_service(wallet: FakeWallet.new, store: OpenReceive::Server::InMemoryInvoiceStore.new,
                    price_provider: nil)
    OpenReceive::Server::Service.new(
      nwc_client: wallet,
      store: store,
      namespace: "default",
      price_provider: price_provider,
      clock: -> { FIXED_NOW }
    )
  end

  def rack_env(method:, path:, body: nil, headers: {})
    env = {
      "REQUEST_METHOD" => method,
      "PATH_INFO" => path,
      "QUERY_STRING" => "",
      "rack.input" => StringIO.new(body.nil? ? "" : JSON.generate(body))
    }
    headers.each { |key, value| env[key] = value }
    env
  end

  # --- Service: checkouts --------------------------------------------------------------------

  def test_get_or_create_checkout_returns_checkout_snapshot
    service = build_service
    checkout = service.get_or_create_checkout("order_id" => "order-1", "amount" => { "sats" => 1000 })

    assert_match(/\Aor_chk_[a-z0-9]+\z/, checkout.fetch("checkout_id"))
    assert_equal "order-1", checkout.fetch("order_id")
    assert_equal "open", checkout.fetch("status")
    assert_equal 1_000_000, checkout.fetch("amount_msats")
    assert_equal FIXED_NOW, checkout.fetch("created_at")
    assert_kind_of Array, checkout.fetch("invoices")
    assert_equal 1, checkout.fetch("invoices").length

    active = checkout.fetch("active")
    assert_equal "incoming", active.fetch("type")
    assert_equal "lightning", active.fetch("rail")
    assert_equal "pending", active.fetch("status")
    assert_equal "order-1", active.fetch("order_id")
    assert_equal 64, active.fetch("payment_hash").length
  end

  def test_idempotent_replay_returns_same_checkout
    wallet = FakeWallet.new
    service = build_service(wallet: wallet)

    first = service.get_or_create_checkout("order_id" => "order-2", "amount" => { "sats" => 1000 })
    second = service.get_or_create_checkout("order_id" => "order-2", "amount" => { "sats" => 1000 })

    assert_equal first.fetch("checkout_id"), second.fetch("checkout_id")
    assert_equal first.fetch("amount_msats"), second.fetch("amount_msats")
    # Only one wallet invoice was minted despite two create calls.
    assert_equal 1, wallet.make_invoice_calls.length
  end

  def test_fiat_checkout_uses_injected_price_provider
    service = build_service(price_provider: StaticPriceProvider.new("100000"))
    checkout = service.get_or_create_checkout(
      "order_id" => "fiat-order",
      "amount" => { "currency" => "USD", "value" => "5.00" }
    )

    assert_equal "open", checkout.fetch("status")
    assert_equal({ "currency" => "USD", "value" => "5.00" }, checkout.fetch("fiat"))
    # 5 USD at 100000 USD/BTC = 5000 sats = 5_000_000 msats.
    assert_equal 5_000_000, checkout.fetch("amount_msats")
  end

  def test_fiat_checkout_without_price_provider_is_scaffolded
    service = build_service # no price provider
    assert_raises(NotImplementedError) do
      service.get_or_create_checkout(
        "order_id" => "fiat-order",
        "amount" => { "currency" => "USD", "value" => "5.00" }
      )
    end
  end

  def test_create_checkout_rejects_top_level_usd_and_sats
    service = build_service
    assert_raises(OpenReceive::Server::ValidationError) do
      service.get_or_create_checkout("order_id" => "legacy-usd", "usd" => "5.00")
    end
    assert_raises(OpenReceive::Server::ValidationError) do
      service.get_or_create_checkout("order_id" => "legacy-sats", "sats" => 1000)
    end
  end

  def test_create_checkout_rejects_nested_btc_fiat_amount
    service = build_service
    assert_raises(OpenReceive::Server::ValidationError) do
      service.get_or_create_checkout(
        "order_id" => "legacy-btc",
        "amount" => { "btc" => { "currency" => "SATS", "value" => "1000" } }
      )
    end
    assert_raises(OpenReceive::Server::ValidationError) do
      service.get_or_create_checkout(
        "order_id" => "legacy-fiat",
        "amount" => { "fiat" => { "currency" => "USD", "value" => "5.00" } }
      )
    end
  end

  # --- Service: settlement via transaction scan ----------------------------------------------

  def test_settled_transaction_scan_marks_invoice_and_order_paid
    store = OpenReceive::Server::InMemoryInvoiceStore.new
    payment_hash = "c" * 64
    store.put_invoice_record(
      "invoice_id" => "or_inv_seed1",
      "namespace" => "default",
      "operation" => "invoice.create",
      "idempotency_key" => "seed-key",
      "idempotency_request_hash" => "sha256:#{'a' * 64}",
      "order_id" => "seed-order",
      "checkout_id" => "or_chk_seed1",
      "payment_hash" => payment_hash,
      "invoice" => "lnbc-seed",
      "amount_msats" => 200_000,
      "transaction_state" => "pending",
      "workflow_state" => "invoice_created",
      "settlement_action_state" => "pending",
      "created_at" => FIXED_NOW,
      "expires_at" => FIXED_NOW + 600,
      "metadata" => { "order_id" => "seed-order", "checkout_id" => "or_chk_seed1" }
    )

    wallet = FakeWallet.new(
      transactions: [{
        "type" => "incoming",
        "invoice" => "lnbc-seed",
        "payment_hash" => payment_hash,
        "amount" => 200_000,
        "state" => "settled",
        "settled_at" => FIXED_NOW + 200
      }]
    )
    service = build_service(wallet: wallet, store: store)

    result = service.sweep_pending_invoices
    assert_equal 1, result.fetch("scanned")
    assert_equal 1, result.fetch("settled")
    assert_equal 0, result.fetch("expired")

    order = service.get_order(order_id: "seed-order")
    assert_equal "paid", order.fetch("status")
    assert order.fetch("paid")
  end

  def test_create_time_scan_settles_and_order_reports_paid
    store = OpenReceive::Server::InMemoryInvoiceStore.new
    service = build_service(wallet: FakeWallet.new(auto_settle: true), store: store)

    checkout = service.get_or_create_checkout("order_id" => "paid-order", "amount" => { "sats" => 1000 })
    assert_equal "paid", checkout.fetch("status")

    order = service.get_order(order_id: "paid-order")
    assert_equal "paid", order.fetch("status")
    assert order.fetch("paid")
  end

  def test_sweep_with_no_open_invoices_makes_no_wallet_calls
    wallet = FakeWallet.new
    service = build_service(wallet: wallet)
    result = service.sweep_pending_invoices

    assert_equal false, result.fetch("swept")
    assert_equal "no_pending", result.fetch("reason")
    assert_empty wallet.list_transactions_calls
  end

  # --- Service: rates + swaps scaffold -------------------------------------------------------

  def test_quote_rates_uses_price_provider
    service = build_service(price_provider: StaticPriceProvider.new("100000"))
    quote = service.quote_rates(fiat: { "currency" => "USD", "value" => "5.00" })

    assert_equal 5000, quote.fetch("amount_sats")
    assert_equal 5_000_000, quote.fetch("amount_msats")
    assert_equal "static-test", quote.fetch("source")
    assert_equal "100000", quote.fetch("btc_fiat_price")
  end

  def test_list_rates_without_provider_is_scaffolded
    service = build_service
    assert_raises(NotImplementedError) { service.list_rates }
  end

  def test_swaps_are_scaffolded
    service = build_service
    assert_equal({ "enabled" => false, "options" => [] }, service.swap_options(order_id: "x"))
    assert_raises(NotImplementedError) { service.start_swap(order_id: "x") }
    assert_raises(NotImplementedError) { service.swap_quote(order_id: "x") }
    assert_raises(NotImplementedError) { service.refund_swap(attempt_id: "x") }
    assert_raises(NotImplementedError) { service.refresh_swap(attempt_id: "x") }
  end

  def test_order_action_status_merges_swap_options
    store = OpenReceive::Server::InMemoryInvoiceStore.new
    payment_hash = "d" * 64
    store.put_invoice_record(
      "invoice_id" => "or_inv_status1",
      "namespace" => "default",
      "operation" => "invoice.create",
      "idempotency_key" => "status-key",
      "idempotency_request_hash" => "sha256:#{'b' * 64}",
      "order_id" => "status-order",
      "checkout_id" => "or_chk_status1",
      "payment_hash" => payment_hash,
      "invoice" => "lnbc-status",
      "amount_msats" => 200_000,
      "transaction_state" => "pending",
      "workflow_state" => "invoice_created",
      "settlement_action_state" => "pending",
      "created_at" => FIXED_NOW,
      "expires_at" => FIXED_NOW + 600,
      "metadata" => {}
    )
    service = build_service(store: store)
    tokens = OpenReceive::Server::Tokens::Manager.new(store: store, namespace: "default")
    handler = OpenReceive::Server::RequestHandler.new(
      service: service,
      tokens: tokens,
      resolve_order: ->(**) { { "amount" => { "sats" => 200 } } }
    )
    minted = tokens.mint("status-order")
    status, _headers, body = handler.order_action(
      order_id: "status-order",
      raw_body: JSON.generate({}),
      request: {},
      token: minted[:token],
      request_id: "req-status"
    )
    assert_equal 200, status
    assert_equal false, body.fetch("swaps_enabled")
    assert_equal [], body.fetch("swap_pay_options")
    assert_equal "status-order", body.fetch("order_id")
  end

  def test_unknown_order_action_is_validation_error
    store = OpenReceive::Server::InMemoryInvoiceStore.new
    service = build_service(store: store)
    tokens = OpenReceive::Server::Tokens::Manager.new(store: store, namespace: "default")
    handler = OpenReceive::Server::RequestHandler.new(
      service: service,
      tokens: tokens,
      resolve_order: ->(**) { { "amount" => { "sats" => 200 } } }
    )
    status, _headers, body = handler.order_action(
      order_id: "x",
      raw_body: JSON.generate({ "action" => "teleport" }),
      request: {},
      token: nil,
      request_id: "req-bad-action"
    )
    assert_equal 400, status
    assert_equal "INVALID_REQUEST", body.fetch("code")
  end

  # --- Tokens ---------------------------------------------------------------------------------

  def test_capability_token_mint_verify_round_trip_and_hash
    store = OpenReceive::Server::InMemoryInvoiceStore.new
    manager = OpenReceive::Server::Tokens::Manager.new(store: store, namespace: "default")

    minted = manager.mint("order-token")
    assert minted[:created]
    token = minted[:token]
    refute_nil token

    assert manager.verify("order-token", token)
    refute manager.verify("order-token", "not-the-token")
    refute manager.verify("different-order", token)

    replay = manager.mint("order-token")
    refute replay[:created]
    assert_nil replay[:token]
    assert_equal minted[:token_hash], replay[:token_hash]

    # Hash is byte-for-byte the JS hashOrderAccessToken form.
    assert_equal "sha256:#{Digest::SHA256.hexdigest(token)}", OpenReceive::Server::Tokens.hash_token(token)
    assert_equal minted[:token_hash], OpenReceive::Server::Tokens.hash_token(token)
  end

  # --- RackApp --------------------------------------------------------------------------------

  def build_app
    store = OpenReceive::Server::InMemoryInvoiceStore.new
    service = build_service(store: store)
    tokens = OpenReceive::Server::Tokens::Manager.new(store: store, namespace: "default")
    resolve_order = ->(order_id:, client_amount:, metadata:, request:) do
      _ = [order_id, client_amount, metadata, request]
      { "amount" => { "sats" => 1000 } } # authoritative amount, ignores the untrusted client amount
    end
    app = OpenReceive::Server::RackApp.new(
      service: service,
      tokens: tokens,
      resolve_order: resolve_order
    )
    [app, store, tokens]
  end

  def test_rack_post_checkouts_returns_201_and_order_access_token
    app, = build_app
    env = rack_env(
      method: "POST",
      path: "/openreceive/checkouts",
      body: { "order_id" => "rack-order" }
    )
    status, headers, body = app.call(env)

    assert_equal 201, status
    assert_equal "application/json", headers["Content-Type"]
    payload = JSON.parse(body.first)
    checkout = payload.fetch("checkout")
    assert_equal "rack-order", checkout.fetch("order_id")
    # resolve_order is the sole price authority (1000 sats).
    assert_equal 1_000_000, checkout.fetch("amount_msats")
    assert payload.fetch("order_access_token")
  end

  def test_rack_post_checkouts_rejects_client_amount
    app, = build_app
    env = rack_env(
      method: "POST",
      path: "/openreceive/checkouts",
      body: { "order_id" => "rack-order", "sats" => 50 }
    )
    status, _, body = app.call(env)
    assert_equal 400, status
    assert_equal "INVALID_REQUEST", JSON.parse(body.first).fetch("code")
  end

  def test_rack_order_route_requires_token
    app, = build_app
    # Seed an order so the route has something to read.
    create_env = rack_env(method: "POST", path: "/openreceive/checkouts", body: { "order_id" => "rack-order" })
    create_status, _, create_body = app.call(create_env)
    assert_equal 201, create_status
    token = JSON.parse(create_body.first).fetch("order_access_token")

    without_token = rack_env(method: "POST", path: "/openreceive/orders/rack-order", body: { "action" => "status" })
    status, _, body = app.call(without_token)
    assert_equal 403, status
    assert_equal "UNAUTHORIZED", JSON.parse(body.first).fetch("code")

    with_token = rack_env(
      method: "POST",
      path: "/openreceive/orders/rack-order",
      body: { "action" => "status" },
      headers: { "HTTP_AUTHORIZATION" => "Bearer #{token}" }
    )
    ok_status, _, ok_body = app.call(with_token)
    assert_equal 200, ok_status
    order_status = JSON.parse(ok_body.first)
    assert_equal "rack-order", order_status.fetch("order_id")
    assert_equal false, order_status.fetch("swaps_enabled")
    assert_equal [], order_status.fetch("swap_pay_options")
  end

  def test_rack_admin_sweep_fails_closed_by_default
    app, = build_app
    env = rack_env(method: "POST", path: "/openreceive/admin/sweep", body: {})
    status, _, body = app.call(env)

    assert_equal 403, status
    assert_equal "UNAUTHORIZED", JSON.parse(body.first).fetch("code")
  end

  def test_rack_admin_sweep_allowed_when_authorize_opts_in
    store = OpenReceive::Server::InMemoryInvoiceStore.new
    service = build_service(store: store)
    tokens = OpenReceive::Server::Tokens::Manager.new(store: store, namespace: "default")
    app = OpenReceive::Server::RackApp.new(
      service: service,
      tokens: tokens,
      resolve_order: ->(order_id:, client_amount:, metadata:, request:) { { "amount" => { "sats" => 1000 } } },
      authorize: ->(context) { context[:action] == "invoice.sweep" }
    )
    env = rack_env(method: "POST", path: "/openreceive/admin/sweep", body: {})
    status, _, body = app.call(env)

    assert_equal 200, status
    assert JSON.parse(body.first).key?("swept")
  end

  def test_rack_scaffolded_swap_action_maps_to_500_not_implemented
    app, = build_app
    create = rack_env(method: "POST", path: "/openreceive/checkouts", body: { "order_id" => "swap-order" })
    _, _, create_body = app.call(create)
    token = JSON.parse(create_body.first).fetch("order_access_token")

    env = rack_env(
      method: "POST",
      path: "/openreceive/orders/swap-order",
      body: { "action" => "start_swap", "pay_in_asset" => "USDT_TRON" },
      headers: { "HTTP_AUTHORIZATION" => "Bearer #{token}" }
    )
    status, _, body = app.call(env)
    assert_equal 500, status
    assert_equal "NOT_IMPLEMENTED", JSON.parse(body.first).fetch("code")
  end

  def test_rack_unknown_route_is_404
    app, = build_app
    env = rack_env(method: "GET", path: "/openreceive/nope", body: nil)
    status, = app.call(env)
    assert_equal 404, status
  end

  # --- Presets (guest_checkout / with_user) ----------------------------------------------------

  def build_app_with_authorize(authorize)
    store = OpenReceive::Server::InMemoryInvoiceStore.new
    service = build_service(store: store)
    tokens = OpenReceive::Server::Tokens::Manager.new(store: store, namespace: "default")
    OpenReceive::Server::RackApp.new(
      service: service,
      tokens: tokens,
      resolve_order: ->(order_id:, client_amount:, metadata:, request:) { { "amount" => { "sats" => 1000 } } },
      authorize: authorize
    )
  end

  def create_and_token(app, order_id, headers: {})
    env = rack_env(method: "POST", path: "/openreceive/checkouts", body: { "order_id" => order_id }, headers: headers)
    status, resp_headers, body = app.call(env)
    assert_equal 201, status
    [JSON.parse(body.first).fetch("order_access_token"), resp_headers]
  end

  def test_preset_guest_checkout_gates_reads_on_token
    app = build_app_with_authorize(OpenReceive::Server::Presets.guest_checkout)

    # checkout.create is always allowed; Tier-2 read denied without a token, allowed with it.
    token, = create_and_token(app, "cs-order")

    no_token = rack_env(method: "POST", path: "/openreceive/orders/cs-order", body: { "action" => "status" })
    assert_equal 403, app.call(no_token)[0]

    with_token = rack_env(
      method: "POST", path: "/openreceive/orders/cs-order", body: { "action" => "status" },
      headers: { "HTTP_AUTHORIZATION" => "Bearer #{token}" }
    )
    assert_equal 200, app.call(with_token)[0]

    # invoice.sweep is denied (no allow_sweep opt-in).
    assert_equal 403, app.call(rack_env(method: "POST", path: "/openreceive/admin/sweep", body: {}))[0]
  end

  def test_preset_guest_checkout_allow_sweep_opts_in
    app = build_app_with_authorize(
      OpenReceive::Server::Presets.guest_checkout(allow_sweep: ->(ctx) { ctx[:action] == "invoice.sweep" })
    )
    status, _, body = app.call(rack_env(method: "POST", path: "/openreceive/admin/sweep", body: {}))
    assert_equal 200, status
    assert JSON.parse(body.first).key?("swept")
  end

  def test_preset_guest_checkout_unit_reads_token_valid
    policy = OpenReceive::Server::Presets.guest_checkout
    assert_equal true, policy.call({ action: "checkout.create", token_valid: false })
    assert_equal false, policy.call({ action: "invoice.sweep", token_valid: true })
    assert_equal true, policy.call({ action: "order.read", token_valid: true })
    assert_equal false, policy.call({ action: "order.read", token_valid: false })
  end

  def test_preset_with_user_gates_by_user_and_ownership
    admin = { name: "admin", admin: true }
    member = { name: "member", admin: false }
    get_user = ->(request) { request && request[:user] }
    policy = OpenReceive::Server::Presets.with_user(
      get_user,
      owns_order: ->(user, ctx) { user[:name] == "member" && ctx.dig(:resource, :order_id) == "own-order" },
      is_admin: ->(user) { user[:admin] }
    )

    # No user → deny everything, even checkout.create.
    assert_equal false, policy.call({ action: "checkout.create", request: { user: nil }, resource: {}, token_valid: true })
    # Present user may always create.
    assert_equal true, policy.call({ action: "checkout.create", request: { user: member }, resource: {}, token_valid: false })
    # Sweep only for admins.
    assert_equal false, policy.call({ action: "invoice.sweep", request: { user: member }, resource: {}, token_valid: true })
    assert_equal true, policy.call({ action: "invoice.sweep", request: { user: admin }, resource: {}, token_valid: false })
    # Ownership gates reads (owns_order supplied → ignores token_valid).
    assert_equal true, policy.call({ action: "order.read", request: { user: member }, resource: { order_id: "own-order" }, token_valid: false })
    assert_equal false, policy.call({ action: "order.read", request: { user: member }, resource: { order_id: "other" }, token_valid: true })
  end

  def test_preset_with_user_falls_back_to_token_valid_without_owns_order
    policy = OpenReceive::Server::Presets.with_user(->(request) { request[:user] })
    present = { user: Object.new }
    assert_equal true, policy.call({ action: "order.read", request: present, resource: { order_id: "o" }, token_valid: true })
    assert_equal false, policy.call({ action: "order.read", request: present, resource: { order_id: "o" }, token_valid: false })
  end

  # --- Order-token cookie ---------------------------------------------------------------------

  def test_create_sets_order_token_cookie
    app, = build_app
    _, headers = create_and_token(app, "cookie-order")
    cookie = headers["Set-Cookie"]
    refute_nil cookie
    assert_match(/\Aopenreceive_order_token=[^;]+/, cookie)
    assert_includes cookie, "Path=/openreceive/orders/cookie-order"
    assert_includes cookie, "HttpOnly"
    assert_includes cookie, "SameSite=Lax"
    assert_includes cookie, "Max-Age=86400"
  end

  def test_cookie_only_read_is_authorized_and_wrong_cookie_is_403
    app, = build_app
    token, = create_and_token(app, "cookie-read")

    # Read with ONLY the cookie (no Authorization / X-OpenReceive-Order-Token header).
    ok = rack_env(
      method: "POST", path: "/openreceive/orders/cookie-read", body: { "action" => "status" },
      headers: { "HTTP_COOKIE" => "openreceive_order_token=#{token}" }
    )
    ok_status, _, ok_body = app.call(ok)
    assert_equal 200, ok_status
    assert_equal "cookie-read", JSON.parse(ok_body.first).fetch("order_id")

    # Wrong cookie value → 403.
    bad = rack_env(
      method: "POST", path: "/openreceive/orders/cookie-read", body: { "action" => "status" },
      headers: { "HTTP_COOKIE" => "openreceive_order_token=not-the-token" }
    )
    assert_equal 403, app.call(bad)[0]
  end

  def test_cookie_secure_flag_tracks_scheme
    app, = build_app
    _, https_headers = create_and_token(app, "secure-order", headers: { "rack.url_scheme" => "https" })
    assert_includes https_headers["Set-Cookie"], "; Secure"

    _, http_headers = create_and_token(app, "plain-order")
    refute_includes http_headers["Set-Cookie"], "Secure"
  end

  def test_token_valid_reaches_custom_authorize
    seen = {}
    app = build_app_with_authorize(->(ctx) { seen[ctx[:action]] = ctx[:token_valid]; true })

    token, = create_and_token(app, "tv-order")
    # No order token is presented on create, so token_valid is false there.
    assert_equal false, seen["checkout.create"]

    app.call(rack_env(
      method: "POST", path: "/openreceive/orders/tv-order", body: { "action" => "status" },
      headers: { "HTTP_AUTHORIZATION" => "Bearer #{token}" }
    ))
    assert_equal true, seen["order.read"]

    app.call(rack_env(method: "POST", path: "/openreceive/orders/tv-order", body: { "action" => "status" }))
    assert_equal false, seen["order.read"]
  end

  # --- ActiveRecord store loads cleanly without a DB -----------------------------------------

  def test_active_record_store_class_is_defined
    assert defined?(OpenReceive::Server::ActiveRecordInvoiceStore)
  end
end
