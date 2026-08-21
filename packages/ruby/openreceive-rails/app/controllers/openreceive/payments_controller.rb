# frozen_string_literal: true

module OpenReceive
  class PaymentsController < ApplicationController
    def check
      openreceive_respond(openreceive_handler.check_payment(
        raw_body: openreceive_raw_body,
        request: request,
        request_id: openreceive_request_id,
        **openreceive_check_pass_arguments
      ))
    end

    private

    # Engine mode serves payments/check from the around_action's gated pass
    # (winner) or the engine-owned row (gate_busy / disabled) — never a second
    # per-invoice wallet walk. Advanced mode (custom repository) has no
    # engine-owned rows: it keeps the handler's legacy per-invoice behavior.
    def openreceive_check_pass_arguments
      return {} if OpenReceive.config.advanced_hooks?

      {
        reconcile_pass: @openreceive_reconcile_pass || { "reason" => "disabled" },
        attempt_status: lambda do |payment_hash|
          payment = OpenReceivePayment.find_by(payment_hash: payment_hash.to_s.downcase)
          next nil if payment.nil?

          {
            "status" => payment.status,
            "paid_at" => payment.paid_at&.to_i
          }.compact
        end
      }
    end
  end
end
