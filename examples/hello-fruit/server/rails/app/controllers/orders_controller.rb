# frozen_string_literal: true

class OrdersController < ApplicationController
  def create
    order = CreateFruitOrder.call(
      cart: order_params[:cart],
      currency: order_params[:currency]
    )
    render json: { order_id: order.id, summary: order.summary }, status: :created
  rescue CreateFruitOrder::Error, ActiveRecord::RecordNotFound, ArgumentError => e
    render json: { message: e.message }, status: :unprocessable_entity
  end

  def show
    order = Order.includes(:order_items).find(params[:id])
    render json: order.summary
  end

  private

  def order_params
    params.permit(:currency, cart: %i[id product_id quantity])
  end
end
