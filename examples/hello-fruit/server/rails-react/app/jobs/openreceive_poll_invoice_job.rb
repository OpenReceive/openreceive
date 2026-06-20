class OpenreceivePollInvoiceJob < ApplicationJob
  queue_as :default

  def perform(invoice_id)
    invoice = OpenReceive::Rails.adapter.verify_invoice(invoice_id: invoice_id)
    Turbo::StreamsChannel.broadcast_replace_to(
      "openreceive_invoice_#{invoice.fetch("invoice_id")}",
      target: "openreceive_invoice_#{invoice.fetch("invoice_id")}",
      partial: "openreceive/invoice",
      locals: { invoice: invoice }
    )
  end
end
