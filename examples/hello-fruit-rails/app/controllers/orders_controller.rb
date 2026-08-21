# frozen_string_literal: true

class OrdersController < ApplicationController
  def create
    order = Order.create!(
      currency: "USD",
      total: BigDecimal("2.00"),
      status: "pending_payment"
    )
    render json: {
      order_id: order.id,
      summary: {
        uuid: order.id,
        status: order.status,
        total_amount: { currency: order.currency, value: order.total.to_s("F") }
      }
    }, status: :created
  end

  def show
    order = Order.find(params[:id])
    render json: {
      uuid: order.id,
      status: order.status,
      total_amount: { currency: order.currency, value: order.total.to_s("F") }
    }
  end
end
