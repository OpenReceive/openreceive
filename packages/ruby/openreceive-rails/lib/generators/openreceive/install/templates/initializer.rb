# frozen_string_literal: true

# OpenReceive Rails engine configuration. See docs/guides/quickstart-rails.md.
#
# Receive-only: the NWC connection is a server-only secret — it is never sent to the browser and
# never logged. Your app keeps 100% of its authentication; the engine controllers inherit from the
# controller named below and obey the hooks configured here.
OpenReceive.configure do |config|
  # Engine controllers inherit from this — gives them your CSRF protection and current_user.
  config.parent_controller = "ApplicationController"

  # Receive-only NWC connection string (or set config.nwc_client to a pre-built nwc-ruby client).
  config.nwc = ENV.fetch("OPENRECEIVE_NWC", nil)

  # Store namespace (multi-tenant isolation).
  config.namespace = "default"

  # Authorization policy. Context = { action:, request:, resource:, token:, order_id? }.
  # Tiers: 1 = public, 2 = per-order capability token (owner), 3 = privileged (fails closed).
  #
  # This default keeps Tier 1 public, delegates Tier 2 to the built-in capability-token check, and
  # FAILS CLOSED on Tier 3 (invoice.sweep). Replace the branches with your own checks as needed —
  # inside a request you can also reach your app's auth via the OpenReceive::Authorization concern.
  config.authorize = lambda do |context|
    case context[:action]
    when "checkout.create", "rate.list"
      true                                              # Tier 1 — public
    when "invoice.sweep"
      false                                             # Tier 3 — set your admin check to enable
    else
      # Tier 2 — allow a valid per-order capability token (and/or add your own ownership check).
      OpenReceive.config.default_authorize_decision(context)
    end
  end

  # Amount authority — NEVER trust the client price. Return the authoritative amount for the order.
  # Return one of: { usd: "9.99" } | { sats: 21_000 } |
  #   { amount: { "btc" => { "currency" => "SATS", "value" => "21000" } } }.
  config.get_order_amount = lambda do |context|
    raise "OpenReceive: implement config.get_order_amount to return the authoritative amount " \
          "for order #{context[:order_id].inspect}."
  end
end
