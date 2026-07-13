# frozen_string_literal: true

module OpenReceive
  # Controller concern giving a host FULL access to its own auth as an alternative to the
  # `config.authorize` proc. Include it in your own ApplicationController and override
  # `openreceive_authorize(context)` there — it runs in controller context, so `current_user`,
  # Pundit/CanCanCan policies, `warden`, etc. are all available:
  #
  #   class ApplicationController < ActionController::Base
  #     include OpenReceive::Authorization
  #
  #     def openreceive_authorize(context)
  #       case context[:action]
#       when "checkout.prepare", "checkout.create", "order.summary" then true
#       when "invoice.sweep"   then current_user&.admin?
  #       else current_user&.owns_order?(context[:order_id])
  #       end
  #     end
  #   end
  #
  # The engine's OpenReceive::ApplicationController also includes this concern, so its controllers
  # always respond to `openreceive_authorize`. The default implementation below defers to a
  # superclass override when present (`defined?(super)`), then to the configured `config.authorize`
  # proc, and finally to the built-in fail-closed tier policy.
  module Authorization
    extend ActiveSupport::Concern

    # context = { action:, request:, resource:, token:, token_valid:, order_id? }. `token_valid` is
    # the handler-precomputed per-order token validity. Returns a boolean.
    def openreceive_authorize(context)
      # Honor a host override defined on a superclass (their ApplicationController).
      return super if defined?(super)

      configured = OpenReceive.config.authorize
      return configured.call(context) if configured

      OpenReceive.config.default_authorize_decision(context)
    end
  end
end
