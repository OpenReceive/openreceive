class OpenreceivePaymentReceivedJob < ApplicationJob
  queue_as :default

  def perform(notification)
    invoice = OpenReceive::Rails.adapter.handle_payment_received(notification: notification)
    Turbo::StreamsChannel.broadcast_replace_to(
      "openreceive_invoice_#{invoice.fetch("invoice_id")}",
      target: "openreceive_invoice_#{invoice.fetch("invoice_id")}",
      partial: "openreceive/invoice",
      locals: { invoice: invoice }
    )
  end
end
