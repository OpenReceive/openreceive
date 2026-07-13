# frozen_string_literal: true

module OpenReceive
  # POST /orders/:order_id (status | swap action, Tier 2),
  # GET /orders/:order_id/summary (Tier 1), and
  # GET /orders/:order_id/swap-options (Tier 2).
  class OrdersController < ApplicationController
    # GET /orders/:order_id/summary — guest-resume summary from prepare persist (no token required).
    def summary
      openreceive_respond(
        openreceive_handler.read_order_summary(
          order_id: params[:order_id],
          request: request,
          token: openreceive_token,
          request_id: openreceive_request_id,
          authorize: openreceive_authorizer
        )
      )
    end

    # POST /orders/:order_id — order status (action="status"/absent) or a swap action. Swaps are
    # scaffolded in openreceive-server and map to 500 NOT_IMPLEMENTED.
    def perform
      openreceive_respond(
        openreceive_handler.order_action(
          order_id: params[:order_id],
          raw_body: openreceive_raw_body,
          request: request,
          token: openreceive_token,
          request_id: openreceive_request_id,
          authorize: openreceive_authorizer
        )
      )
    end

    # GET /orders/:order_id/swap-options — list swap pay-in options (currently disabled snapshot).
    def swap_options
      openreceive_respond(
        openreceive_handler.read_swap_options(
          order_id: params[:order_id],
          request: request,
          token: openreceive_token,
          request_id: openreceive_request_id,
          authorize: openreceive_authorizer
        )
      )
    end
  end
end
