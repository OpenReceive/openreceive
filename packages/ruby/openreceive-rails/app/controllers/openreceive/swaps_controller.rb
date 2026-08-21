# frozen_string_literal: true

module OpenReceive
  class SwapsController < ApplicationController
    def quote
      respond_with(:quote_swap)
    end

    def create
      respond_with(:create_swap)
    end

    def status
      respond_with(:get_swap)
    end

    def refund
      respond_with(:refund_swap)
    end

    private

    def respond_with(method)
      openreceive_respond(openreceive_handler.public_send(
        method,
        raw_body: openreceive_raw_body,
        request: request,
        request_id: openreceive_request_id
      ))
    end
  end
end
