# frozen_string_literal: true

# Configure during initializer load (not after_initialize). parent_controller is
# read when OpenReceive::ApplicationController is eager-loaded in production.
OpenReceive.configure do |config|
  config.parent_controller = "ApplicationController"
  # Secrets load from NWC_URI, LSC_URI_PRIMARY, and LSC_URI_BACKUP.
  # Keep ordinary settings here in the Rails initializer.
  config.price_currencies = ["USD"]

  # The host authorizes every request; OpenReceive mints no tokens.
  #
  # The default below treats possession of the order id as the authorization:
  # the request must name an order that exists. That is only safe while your
  # order ids are unguessable (UUIDs, not sequential integers). If your ids are
  # enumerable, or an order should only be visible to the customer who placed
  # it, replace this with a session/ownership policy, e.g.:
  #   config.authorize = ->(context) { OrderPolicy.viewer_may?(current_user_for(context), context) }
  config.authorize = lambda { |context|
    resource = context[:resource] || context["resource"]
    order_id = resource&.[](:order_id) || resource&.[]("order_id")
    order_id.present? && <%= order_model_name %>.exists?(order_id)
  }

  # The engine-owned OpenReceivePayment rows serialize per order by locking the
  # host order row of this model.
  config.order_model = "<%= order_model_name %>"

  # Load the host-owned order; return nil for an unknown id (mapped to 404).
  config.load_order = ->(order_id) { <%= order_model_name %>.find_by(id: order_id) }

  # The host order is the only price authority; payer input never carries an amount.
  config.amount_for_order = ->(order) { { currency: "USD", value: order.total.to_s } }

  # Runs inside the settlement transaction, only for the order's first settled
  # attempt. `settlement` exposes order_id, payment_hash, and paid_at.
  #
  # TODO(fulfillment): replace the logging placeholder with your real
  # fulfillment — an in-transaction order transition or a transactional outbox
  # insert, e.g.:
  #   config.on_paid = lambda do |settlement|
  #     order = <%= order_model_name %>.find(settlement.order_id)
  #     FulfillOrder.call(order, payment_hash: settlement.payment_hash)
  #   end
  # The placeholder only logs the settlement; the engine warns at every boot
  # while it is still configured, because orders would otherwise be recorded as
  # settled without ever being fulfilled.
  config.on_paid = OpenReceive::LOGGING_ON_PAID

  # Recommended for public web shops: cap invoice creation per client IP,
  # counted from the engine-owned openreceive_payments rows. Leave it off for
  # point-of-sale deployments where many payers share one IP. Behind a proxy,
  # configure Rails' trusted proxies so request.ip is the payer.
  # config.rate_limiting = true

  # Settlement discovery is opportunistic by default: every engine request
  # first runs one reconcile pass through the durable openreceive_meta gate
  # (shared by all Puma workers; min 2s between real wallet scans), so pending
  # attempts settle or close on any later OpenReceive call — no scheduled job
  # required. Set false only if a dedicated worker owns scanning.
  # config.opportunistic_reconcile = false
end

# Optional: for push settlement the moment the wallet reports payment_received,
# run the long-lived worker `bin/rails openreceive:notifications` — it listens
# for NWC-02 notifications AND reconciles periodically in the same process (the
# safety net for notifications missed while it was down). One-shot primitives
# (`bin/rails openreceive:reconcile`, OpenReceive::ReconcileJob) remain
# available; there is no need to schedule them.
