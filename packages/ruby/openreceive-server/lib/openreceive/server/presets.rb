# frozen_string_literal: true

module OpenReceive
  module Server
    # Ready-made `authorize` policies for the two common host shapes — the Ruby port of the shipped
    # @openreceive/http presets (presets.ts). Both build on the handler-precomputed
    # `context[:token_valid]` (per-order token validity), so neither touches the token manager, a
    # session store, or any manager wiring. Pass one as `authorize:` to RackApp / RequestHandler, or
    # assign it to `config.authorize` in the Rails engine.
    #
    # The callables accept the SAME context hash the handler passes every authorize/rate_limit hook:
    #   { action:, request:, resource:, token:, token_valid:, order_id? }
    module Presets
      module_function

      # Policy for an guest-checkout site (no accounts) / paywall: anyone may prepare and create a
      # checkout (and read order summaries), per-order reads and swap actions are gated on the order's
      # capability token (the httpOnly cookie set on create is enough), and admin sweep is denied
      # unless `allow_sweep` opts in. Byte-identical to the JS `guestCheckout`:
      # checkout.prepare / checkout.create / order.summary → true; invoice.sweep → allow_sweep&.call(ctx)
      # or false; else → ctx[:token_valid].
      #
      #   authorize: OpenReceive::Server::Presets.guest_checkout
      #   authorize: OpenReceive::Server::Presets.guest_checkout(allow_sweep: ->(ctx) { admin?(ctx) })
      def guest_checkout(allow_sweep: nil)
        lambda do |ctx|
          case ctx[:action]
          when "checkout.prepare", "checkout.create", "order.summary"
            true
          when "invoice.sweep"
            allow_sweep ? allow_sweep.call(ctx) : false
          else
            ctx[:token_valid]
          end
        end
      end

      # Policy for a site with logged-in users: `get_user` resolves the request's user (e.g. from a
      # session) — it receives `ctx[:request]`. A missing user is denied everything; a present user may
      # always prepare/create a checkout and read summaries, may sweep only when `is_admin` allows, and
      # may read/act on an order per `owns_order` (falling back to the order token via ctx[:token_valid]
      # when `owns_order` is not supplied). Byte-identical to the JS `withUser`.
      #
      #   authorize: OpenReceive::Server::Presets.with_user(
      #     ->(request) { current_user_for(request) },
      #     owns_order: ->(user, ctx) { user.owns_order?(ctx[:order_id]) },
      #     is_admin:   ->(user) { user.admin? }
      #   )
      def with_user(get_user, owns_order: nil, is_admin: nil)
        lambda do |ctx|
          user = get_user.call(ctx[:request])
          next false unless user

          case ctx[:action]
          when "checkout.prepare", "checkout.create", "order.summary"
            true
          when "invoice.sweep"
            is_admin ? is_admin.call(user) : false
          else
            owns_order ? owns_order.call(user, ctx) : ctx[:token_valid]
          end
        end
      end
    end
  end
end
