# frozen_string_literal: true

module OpenReceive
  class CheckoutsController < ApplicationController
    def prepare
      openreceive_respond(openreceive_handler.prepare_checkout(
        raw_body: openreceive_raw_body,
        request: request,
        request_id: openreceive_request_id
      ))
    end

    def create
      openreceive_respond(openreceive_handler.create_checkout(
        raw_body: openreceive_raw_body,
        request: request,
        request_id: openreceive_request_id
      ))
    end
  end
end
