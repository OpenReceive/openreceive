# frozen_string_literal: true

module OpenReceive
  # POST /admin/sweep — reconcile pending invoices (Tier 3). FAILS CLOSED: returns 403 unless the
  # configured authorize hook (or an Authorization concern override) explicitly grants it.
  class AdminController < ApplicationController
    def sweep
      openreceive_respond(
        openreceive_handler.admin_sweep(
          request: request,
          token: openreceive_token,
          request_id: openreceive_request_id,
          authorize: openreceive_authorizer
        )
      )
    end
  end
end
