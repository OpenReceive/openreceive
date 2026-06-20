# frozen_string_literal: true

class OpenreceivePollInvoiceJob < ApplicationJob
  queue_as :default

  def perform(invoice_id)
    invoice = OpenReceive::Rails.adapter.verify_invoice(invoice_id: invoice_id)
    broadcast_invoice(invoice)
  end

  private

  def broadcast_invoice(invoice)
    return unless defined?(Turbo::StreamsChannel)

    Turbo::StreamsChannel.broadcast_replace_to(
      "openreceive_invoice_#{invoice.fetch("invoice_id")}",
      target: "openreceive_invoice_#{invoice.fetch("invoice_id")}",
      partial: "openreceive/invoice",
      locals: { invoice: invoice }
    )
  end
end
