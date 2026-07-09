# frozen_string_literal: true

module OpenReceive
  # POST /checkouts (create, Tier 1) and GET /checkouts/:checkout_id (read, Tier 2).
  class CheckoutsController < ApplicationController
    # POST /checkouts — create-or-get a checkout. Returns the Checkout (201) plus, on the first
    # checkout for an order, the one-time `order_access_token`.
    def create
      openreceive_respond(
        openreceive_handler.create_checkout(
          raw_body: openreceive_raw_body,
          request: request,
          token: openreceive_token,
          request_id: openreceive_request_id,
          authorize: openreceive_authorizer
        )
      )
    end

    # GET /checkouts/:checkout_id — read a checkout (Tier 2; owner token required by default).
    def show
      openreceive_respond(
        openreceive_handler.read_checkout(
          checkout_id: params[:checkout_id],
          request: request,
          token: openreceive_token,
          request_id: openreceive_request_id,
          authorize: openreceive_authorizer
        )
      )
    end
  end
end
