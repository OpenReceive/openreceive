# frozen_string_literal: true

module OpenReceive
  # POST /prepare — Tier 1. Host price authority; persists amount under host_order:<order_id>.
  class PrepareController < ApplicationController
    def create
      openreceive_respond(
        openreceive_handler.prepare_checkout(
          raw_body: openreceive_raw_body,
          request: request,
          token: openreceive_token,
          request_id: openreceive_request_id,
          authorize: openreceive_authorizer
        )
      )
    end
  end
end
