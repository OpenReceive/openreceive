# frozen_string_literal: true

class DeliveriesController < ApplicationController
  def show
    order = Order.includes(:order_items).find(params[:order_id])
    unless order.status == "paid"
      return render json: { message: "Order is not fulfilled yet." }, status: :forbidden
    end

    item = order.order_items.find_by(product_id: params[:product_id])
    return render json: { message: "Product not on this order." }, status: :not_found if item.nil?

    file = File.basename(item.sticker_path)
    path = Rails.public_path.join("stickers", file).expand_path
    return render json: { message: "Sticker not found." }, status: :not_found unless path.file?

    send_file path, type: "image/svg+xml", disposition: "inline"
  end
end
