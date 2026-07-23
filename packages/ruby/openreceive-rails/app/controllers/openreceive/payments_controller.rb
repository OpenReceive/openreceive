# frozen_string_literal: true

module OpenReceive
  class PaymentsController < ApplicationController
    def check
      openreceive_respond(openreceive_handler.check_payment(
        raw_body: openreceive_raw_body,
        request: request,
        request_id: openreceive_request_id
      ))
    end
  end
end
