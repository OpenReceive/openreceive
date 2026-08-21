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

  # The host authorizes every request; OpenReceive mints no tokens.
  config.authorize = ->(context) { OpenReceiveOrderPolicy.authorized?(context) }

  # The engine-owned OpenReceivePayment rows serialize per order by locking the
  # host order row of this model.
  config.order_model = "Order"

  # Load the host-owned order; nil for an unknown id (mapped to 404).
  config.load_order = ->(order_id) { Order.find_by(id: order_id) }

  # The host order is the only price authority; payer input never carries an amount.
  config.amount_for_order = ->(order) { HelloFruitRails::CheckoutAmount.for_order(order) }

  # Runs inside the settlement transaction, only for the order's first settled
  # attempt. `settlement` exposes order_id, payment_hash, and paid_at.
  config.on_paid = lambda do |settlement|
    order = Order.find(settlement.order_id)
    FulfillOrder.call(order, payment_hash: settlement.payment_hash)
  end
end

# Settlement discovery is opportunistic by default: every engine request runs
# one reconcile pass through the durable openreceive_meta gate (shared by all
# workers; min 2s between real wallet scans), so pending attempts settle or
# close on any later OpenReceive call — no scheduled job or demo loop needed.
# Optional push: `bin/rails openreceive:notifications` listens for NWC-02
# payment_received and reconciles periodically in the same worker process.
