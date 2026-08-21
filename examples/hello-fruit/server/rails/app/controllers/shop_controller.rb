# frozen_string_literal: true

class ShopController < ApplicationController
  # SPA shell: one #root div plus the #__app_bootstrap JSON blob the MobX
  # Keystone workspace hydrates from (catalog, currencies, and — when the
  # request is /checkout/:order_id — the order to resume). This HTML is never
  # cached; pack tags go through Shakapacker's manifest so new digests are
  # picked up on deploy.
  def index
    expires_now
    response.headers["Cache-Control"] = HelloFruit::PublicCacheHeaders::NO_STORE
    @app_data = app_data
    render :index
  end

  private

  def app_data
    order = Order.includes(:order_items).find_by(id: params[:order_id]) if params[:order_id].present?
    {
      fruits: Product.order(:name).map do |product|
        {
          id: product.id,
          name: product.name,
          sticker: product.sticker_public_path,
          fiat: product.amount
        }
      end,
      product: product_info,
      currencies: CreateFruitOrder::SUPPORTED,
      order: order&.summary,
      # config/routes.rb owns the mount path; the client hydrates it from here
      # rather than keeping a second copy.
      openreceive_prefix: open_receive_path
    }
  end

  # Title/description come from the shared demo catalog, same as the Node demos.
  def product_info
    @product_info ||= begin
      shared = JSON.parse(Rails.root.join("../../shared/product.json").read)
      { name: shared.fetch("name"), description: shared.fetch("description") }
    end
  end
end
