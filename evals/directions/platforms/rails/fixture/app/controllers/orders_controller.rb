class OrdersController < ApplicationController
  def create
    product = Product.find(params[:product_id])
    order = Order.create!(
      user_id: current_user_id,
      product_name: product.name,
      amount: product.price,
      currency: "USD",
      status: "awaiting_payment",
    )
    redirect_to order_path(order), status: :see_other
  end

  def show
    @order = Order.find_by(id: params[:id], user_id: viewer_id)
    head :not_found unless @order
  end
end
