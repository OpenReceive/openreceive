class HelloFruitController < ApplicationController
  def index
    @amount_msats = 200_000
    @fruits = %w[apple banana orange pear]
  end

  def health
    render json: { ok: true, demo: "rails-hotwire" }
  end

  def metadata
    render json: {
      demo: "rails-hotwire",
      wallet_configured: ENV["OPENRECEIVE_NWC"].to_s != "",
      nwc_secret_exposed: false
    }
  end
end
