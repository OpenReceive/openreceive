class CatalogController < ApplicationController
  def index
    @products = Product.order(:id)
  end

  def health
    render plain: "ok\n"
  end
end
