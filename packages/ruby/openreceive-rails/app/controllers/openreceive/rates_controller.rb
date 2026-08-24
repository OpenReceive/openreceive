# frozen_string_literal: true

module OpenReceive
  class RatesController < ApplicationController
    # Unauthenticated and payment-free: a crawler or health check hitting
    # /rates must not consume the NWC scan budget. The JS handler returns
    # before its opportunistic pass for the same route.
    skip_around_action :openreceive_opportunistic_reconcile

    def index
      openreceive_respond(openreceive_handler.read_rates(
        query_string: request.query_string,
        request: request,
        request_id: openreceive_request_id
      ))
    end
  end
end
