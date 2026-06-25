class HelloFruitController < ApplicationController
  def index
    @amount_msats = 200_000
    @fruits = %w[apple banana orange pear]
  end

  def metadata
    render json: {
      demo: "rails-react",
      quarantined: true,
      wallet_configured: ENV["OPENRECEIVE_NWC"].to_s != "",
      nwc_secret_exposed: false
    }
  end

  def create_order
    render json: {
      code: "NOT_IMPLEMENTED",
      message: "Rails React is quarantined; use the JS demos for the full cart-to-order flow."
    }, status: :not_implemented
  end

  def order_status
    render json: {
      code: "NOT_IMPLEMENTED",
      message: "Rails React is quarantined; use the JS demos for the full cart-to-order flow."
    }, status: :not_implemented
  end
end
