# frozen_string_literal: true

# Initializers run before production eager_load. parent_controller must be set
# here (not in after_initialize): OpenReceive::ApplicationController resolves its
# superclass when the class file loads during eager_load, which happens before
# after_initialize hooks.
require Rails.root.join("app/models/money_format")

module HelloFruitRails
  module CheckoutAmount
    module_function

    def for_order(order)
      value = MoneyFormat.call(order.total, currency: order.currency)
      return { "sats" => value } if order.currency == "SATS"

      { "currency" => order.currency, "value" => value }
    end
  end
end

OpenReceive.configure do |config|
  config.parent_controller = "ApplicationController"
  config.price_currencies = ["USD"]

  # Built-in cached live BTC/USD feed (CoinGecko-compatible primary plus the
  # OpenReceive fallback mirror) — the same defaults the Node demo gets from
  # createOpenReceive. OPENRECEIVE_PRICE_FEED_*_URL env vars override the
  # URLs for dev/test, exactly like node-express.
  config.price_provider = OpenReceive::Rates.create_cached_live_price_feed(
    currencies: ["USD"],
    **OpenReceive::Rates.read_price_feed_url_overrides(ENV)
  )

  # Recommended for public web shops (matches node-express `rateLimiting:
  # true`): cap invoice creation per client IP, counted from the engine-owned
  # openreceive_payments rows this host already persists. Off by default —
  # leave it off for point-of-sale deployments, where many payers share the
  # terminal's IP. Behind a reverse proxy, configure Rails' trusted proxies so
  # request.ip is the payer, not the proxy.
  config.rate_limiting = true

  # The host authorizes every request; OpenReceive mints no tokens. `context`
  # is { action:, request:, resource: } — the route name, the
  # ActionDispatch::Request, and the payer-claimed { reference:, payment_hash: }.
  # The policy model documents the keys and the demo's ownership rule.
  config.authorize = ->(context) { OpenReceiveOrderPolicy.authorized?(context) }

  # The price for an order id; nil for an unknown id (mapped to 404). The host
  # order is the only price authority; payer input never carries an amount.
  config.amount_for = lambda do |reference|
    order = Order.find_by(id: reference)
    order && HelloFruitRails::CheckoutAmount.for_order(order)
  end

  # Runs inside the settlement transaction, only for the order's first settled
  # attempt. `settlement` exposes reference, payment_hash, and paid_at.
  # Runs inside the settlement transaction, and OpenReceive already guarantees
  # it fires at most once per order across its own settlement paths. It is
  # still written as a guarded transition, because that is the shape a real
  # shop needs the moment anything else can also fulfill an order.
  config.on_paid = lambda do |settlement|
    FulfillOrder.call(settlement.reference, payment_hash: settlement.payment_hash)
  end
end

# Settlement discovery is opportunistic by default: every engine request runs
# one reconcile pass through the durable openreceive_meta gate (shared by all
# workers; min 2s between real wallet scans), so pending attempts settle or
# close on any later OpenReceive call — no scheduled job or demo loop needed.
# Optional push: `bin/rails openreceive:notifications` listens for NWC-02
# payment_received and reconciles periodically in the same worker process.
