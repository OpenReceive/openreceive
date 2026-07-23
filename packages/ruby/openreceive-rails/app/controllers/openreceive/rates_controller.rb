# frozen_string_literal: true

module OpenReceive
  class RatesController < ApplicationController
    def index
      openreceive_respond(openreceive_handler.read_rates(
        query_string: request.query_string,
        request: request,
        token: openreceive_token,
        request_id: openreceive_request_id
      ))
    end
  end
end
