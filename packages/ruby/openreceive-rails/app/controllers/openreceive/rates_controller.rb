# frozen_string_literal: true

module OpenReceive
  # GET /rates — public rate quotes (Tier 1). Requires a configured price_provider; without one the
  # Service raises NOT_IMPLEMENTED (mapped to 500), mirroring openreceive-server.
  class RatesController < ApplicationController
    def index
      openreceive_respond(
        openreceive_handler.read_rates(
          query_string: request.query_string,
          request: request,
          token: openreceive_token,
          request_id: openreceive_request_id,
          authorize: openreceive_authorizer
        )
      )
    end
  end
end
