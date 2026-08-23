# frozen_string_literal: true

# The engine calls config.authorize with a Hash: context[:action] (the route
# name, e.g. "checkout.create"), context[:request] (the ActionDispatch::Request),
# and context[:resource] ({ reference:, payment_hash: } from the payer's body —
# it names an order, it does not prove ownership). The demo has no user
# accounts, so possession of a real order id — a UUID the payer can only have
# from their own checkout page — is the whole policy.
module OpenReceiveOrderPolicy
  module_function

  def authorized?(context)
    reference = context.dig(:resource, :reference)
    reference.present? && Order.exists?(reference)
  end
end
