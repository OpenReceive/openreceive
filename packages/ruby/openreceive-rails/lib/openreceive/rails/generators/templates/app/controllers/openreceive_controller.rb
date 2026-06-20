# frozen_string_literal: true

class OpenreceiveController < ApplicationController
  protect_from_forgery with: :exception

  def create
    result = openreceive_adapter.create_invoice(
      controller: self,
      params: openreceive_create_params.to_h,
      headers: request.headers
    )
    render json: result.fetch("body"), status: result.fetch("status")
  end

  def show
    result = openreceive_adapter.lookup_invoice(
      controller: self,
      invoice_id: params.fetch(:invoice_id)
    )
    render json: result.fetch("body"), status: result.fetch("status")
  end

  private

  def openreceive_adapter
    OpenReceive::Rails.adapter
  end

  def openreceive_create_params
    params.permit(
      :amount_msats,
      :description,
      :description_hash,
      :expiry,
      :idempotency_key,
      :fruit,
      :order_id
    )
  end
end
