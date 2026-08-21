# frozen_string_literal: true

OpenReceive.configure do |config|
  config.parent_controller = "ApplicationController"
  # The wallet secret loads from NWC_URI. This quickstart is Lightning-only:
  # LSC_URI_PRIMARY / LSC_URI_BACKUP swap rails come from the engine defaults
  # and are exercised by the full demo (../hello-fruit/server/rails).
  config.price_currencies = ["USD"]

  # USD orders need a BTC/USD price. Use the gem's built-in cached live feed
  # (CoinGecko-compatible primary with a fallback mirror); the
  # OPENRECEIVE_PRICE_FEED_*_URL env vars override the URLs for dev/test.
  config.price_provider = OpenReceive::Rates.create_cached_live_price_feed(
    currencies: ["USD"],
    **OpenReceive::Rates.read_price_feed_url_overrides(ENV)
  )

  # The host authorizes every request; OpenReceive mints no tokens.
  config.authorize = ->(context) { OpenReceiveOrderPolicy.authorized?(context) }

  # The engine-owned OpenReceivePayment rows serialize per order by locking the
  # host order row of this model.
  config.order_model = "Order"

  # Load the host-owned order; nil for an unknown id (mapped to 404).
  config.load_order = ->(order_id) { Order.find_by(id: order_id) }

  # The host order is the only price authority; payer input never carries an amount.
  config.amount_for_order = ->(order) { { currency: order.currency, value: order.total.to_s("F") } }

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
