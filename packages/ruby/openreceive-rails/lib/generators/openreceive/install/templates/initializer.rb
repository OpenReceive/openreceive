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
  # `context` is a Hash with three symbol keys:
  #   context[:action]   — which route: "checkout.prepare", "checkout.create",
  #                        "payment.check", "swap.quote", "swap.create",
  #                        "swap.read", or "swap.refund"
  #   context[:request]  — the ActionDispatch::Request; read your session,
  #                        cookies, or headers from it, as in a controller
  #   context[:resource] — { reference:, payment_hash: } copied from the
  #                        payer's JSON body. It names an order; it does not
  #                        prove this caller owns it.
  # Return true to allow the request, false for a 403.
  #
  # The default below allows every request, treating possession of the
  # reference as the authorization (an unknown reference is still a 404,
  # because amount_for returns nil for it). That is only safe while your
  # references are unguessable (UUIDs, not sequential integers). If they are
  # enumerable, or an order should only be visible to the customer who placed
  # it, check ownership against your own session instead (`Order` stands in
  # for your own model — any name works; OpenReceive never sees it):
  #   config.authorize = lambda do |context|
  #     order = Order.find_by(id: context[:resource][:reference])
  #     order && order.user_id == context[:request].session[:user_id]
  #   end
  config.authorize = ->(_context) { true }

  # The price for a reference — the string your checkout passes, typically
  # your order id. Your application is the only price authority; payer input
  # never carries an amount. Return { currency: "USD", value: "12.00" } or
  # { sats: 1200 }, or nil when there is nothing to pay for (a 404). The
  # engine refuses to serve checkouts until this is set.
  #
  # TODO(price): look the reference up in your own application, e.g.
  # config.amount_for = lambda do |reference|
  #   order = Order.find_by(id: reference)
  #   order && { currency: "USD", value: order.total.to_s }
  # end

  # Runs inside the settlement transaction, only for the order's first settled
  # attempt. `settlement` exposes reference, payment_hash, and paid_at.
  #
<%= fulfillment_note("  # ") %>
  #
  # TODO(fulfillment): replace the logging placeholder with your real
  # fulfillment. Written as the guarded transition described above, so a
  # second fulfillment path can never ship the same order twice.
  # (FulfillOrder stands in for your own application code — ship the goods,
  # enqueue the confirmation email. OpenReceive does not provide it.)
  #
  #   config.on_paid = lambda do |settlement|
  #     claimed = Order
  #                 .where(id: settlement.reference, state: "awaiting_payment")
  #                 .update_all(state: "paid", paid_at: Time.at(settlement.paid_at).utc)
  #     next if claimed.zero? # someone else already fulfilled it
  #
  #     FulfillOrder.call(Order.find(settlement.reference),
  #                       payment_hash: settlement.payment_hash)
  #   end
  #
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
