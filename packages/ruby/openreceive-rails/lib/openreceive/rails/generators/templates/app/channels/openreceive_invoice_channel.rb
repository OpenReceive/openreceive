# frozen_string_literal: true

class OpenreceiveInvoiceChannel < ApplicationCable::Channel
  def subscribed
    invoice_id = params.fetch(:invoice_id)
    invoice = OpenReceive::Rails.configuration.store.find_by_invoice_id(invoice_id)
    reject if invoice.nil?
    reject unless authorized_invoice?(invoice)

    stream_from "openreceive_invoice_#{invoice_id}"
  end

  private

  def authorized_invoice?(invoice)
    hook = OpenReceive::Rails.configuration.authorize_invoice
    return true if hook.nil?

    hook.call(self, invoice)
  end
end
