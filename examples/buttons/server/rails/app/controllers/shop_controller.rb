# frozen_string_literal: true

# The shop's own pages and JSON API. OpenReceive owns none of it: it never sees
# an order, a cart, a price, a product or a download. The SPA talks to these
# routes for everything except the payment itself, which goes to the mounted
# engine at /openreceive.
class ShopController < ApplicationController
  include ShopIdentity

  # GET / — the SPA shell plus the bootstrap payload it hydrates from.
  #
  # This HTML is never cached: it names the current pack digests, and a cached
  # copy leaves browsers on a dead bundle after a deploy.
  def index
    expires_now
    response.headers["Cache-Control"] = ButtonShop::PublicCacheHeaders::NO_STORE
    @app_data = bootstrap_payload
    render :index
  end

  # POST /shop/orders — one cart becomes one order becomes one reference.
  #
  # The reference has to exist BEFORE checkout and survive every retry, so it is
  # minted here, once, and the browser holds it. A fresh id per attempt would
  # let one cart be paid twice.
  def create_order
    lines = normalized_lines
    return render_error("Your cart is empty.") if lines.empty?

    order = ShopOrder.create_from_lines!(lines, shop_user: current_shop_user)
    render json: order_payload(order), status: :created
  end

  # GET /shop/orders/:id — the order as THIS browser is allowed to see it.
  # The SPA polls this after settlement to learn the downloads have unlocked;
  # `state` flips only in `config.on_paid`.
  def show_order
    order = authorized_order
    return head :not_found unless order

    render json: order_payload(order)
  end

  # GET /shop/orders/:id/downloads/:sku — the thing that was bought.
  #
  # Fulfillment is gated on the ORDER ROW, not on anything the browser says:
  # `paid` is written inside OpenReceive's settlement transaction and nowhere
  # else.
  def download
    order = authorized_order
    return head :not_found unless order
    return head :forbidden unless order.paid?

    item = order.items.find_by(sku: params[:sku])
    return head :not_found unless item

    # The snapshot names the SKU; the file name comes from the product row when
    # it still exists, and from the SKU convention when it does not — a
    # deactivated or deleted product must not break a download somebody paid
    # for.
    image_name = item.product&.image_name || "openreceive-#{item.sku}-button.webp"
    path = ShopController.artwork_root.join(image_name)
    return head :not_found unless File.file?(path)

    send_file path, type: "image/webp", disposition: "attachment", filename: image_name
  end

  # GET /shop/recent_orders — public, unauthenticated, paid orders only.
  #
  # Paid-only is also the anti-spam design. Anyone can POST /shop/orders as many
  # times as they like; if the feed showed unpaid orders it would be a free
  # billboard. An entry here costs a real payment.
  def recent_orders
    orders = ShopOrder.recent
                      .includes(:shop_user, items: :product)
                      .limit(ShopOrder::FEED_LIMIT)

    # Public and identical for everyone, so it caches. That is only true because
    # there is no per-visitor field in the body — the SPA draws its own "You"
    # badge by comparing each row's buyer against the public_ref in the
    # bootstrap payload.
    expires_in 10.seconds, public: true

    render json: {
      orders: orders.map { |order| feed_payload(order) },
      totals: {
        paid_orders: ShopOrder.paid.count,
        buttons_sold: ShopOrderItem.joins(:shop_order)
                                   .where(shop_orders: { state: ShopOrder::PAID })
                                   .sum(:quantity)
      }
    }
  end

  # The one copy of the artwork, at examples/buttons/images. Four stacks read
  # this directory; nobody copies the files.
  def self.artwork_root
    @artwork_root ||= Rails.root.join("../../images").expand_path
  end

  private

  # Possession of an order id is a CLAIM, not proof. Same rule the engine's
  # `config.authorize` applies: the order has to belong to this browser.
  #
  # Another visitor's order is 404 and never 403 — do not confirm that an id
  # exists.
  def authorized_order
    order = ShopOrder.find_by_reference(params[:id])
    return nil unless order && order.shop_user_id == current_shop_user.id

    order
  end

  # THE TRUST BOUNDARY.
  #
  # The cart is a list of claims. Only the SKU and the quantity survive: each
  # SKU is looked up in ShopProduct.active and the price comes from that row,
  # never from the request. An unknown or deactivated SKU is DROPPED rather than
  # rejecting the whole request, quantities are coerced and clamped, duplicate
  # lines are merged, and the result is re-emitted in catalog order.
  def normalized_lines
    requested = params[:items]
    return [] unless requested.is_a?(Array)

    quantities = Hash.new(0)
    requested.each do |line|
      next unless line.respond_to?(:[])

      product = ShopProduct.active_by_sku(line[:sku].is_a?(String) ? line[:sku] : nil)
      next unless product

      quantity = line[:quantity].to_i
      next unless quantity.positive?

      quantities[product.id] =
        [quantities[product.id] + quantity, ShopProduct::MAX_PER_SKU].min
    end

    return [] if quantities.empty?

    ShopProduct.active.ordered.where(id: quantities.keys).filter_map do |product|
      quantity = quantities[product.id]
      { product: product, quantity: quantity } if quantity.positive?
    end
  end

  def bootstrap_payload
    {
      shop: {
        currency: "USD",
        max_per_sku: ShopProduct::MAX_PER_SKU,
        # config/routes.rb owns the mount path; the client hydrates it from
        # here rather than keeping a second copy.
        openreceive_prefix: open_receive_path,
        # The catalog ships FROM THE SERVER because the prices are ours and the
        # image URLs are digested: the browser could not derive either, and
        # must not be allowed to supply them.
        catalog: ShopProduct.active.ordered.map do |product|
          {
            sku: product.sku,
            name: product.name,
            price_cents: product.price_cents,
            image_url: helpers.asset_path(product.image_name)
          }
        end,
        # The public handle only. The private id stays in the signed cookie.
        visitor: { public_ref: current_shop_user.public_ref }
      }
    }
  end

  # The PRIVATE order payload. It carries `download_path`, which on a paid order
  # is a live download URL — see `feed_payload` for why these two must never
  # converge.
  def order_payload(order)
    {
      reference: order.id,
      state: order.state,
      currency: order.currency,
      total_cents: order.total_cents,
      total_amount: order.total_amount,
      description: order.checkout_description,
      paid_at: order.paid_at&.to_i,
      items: order.items.map do |item|
        {
          sku: item.sku,
          name: item.name.presence || item.sku,
          quantity: item.quantity,
          unit_price_cents: item.unit_price_cents,
          # Present only once the order is paid: the SPA renders a download
          # button from this and nothing else.
          download_path: order.paid? ? shop_order_download_path(order, item.sku) : nil
        }
      end
    }
  end

  # A SECOND payload method ON PURPOSE, and an explicit WHITELIST — never a
  # reject-list, never `order_payload.except(…)`.
  #
  # The natural failure mode is reusing the private payload here because it is
  # already written. It carries `download_path`, and for a paid order that is a
  # live download URL for somebody else's purchase.
  #
  # The order id is excluded because `shop_orders.id` IS the OpenReceive
  # reference: the key `checkout.prepare` and `checkout.create` are called with,
  # protected only by `authorize`. It has no business in a public payload, a
  # truncated prefix buys nothing, and the SPA keys its rows on the array index.
  #
  # test/controllers/shop_feed_test.rb asserts the SERIALIZED BODY carries none
  # of it.
  def feed_payload(order)
    {
      buyer: order.shop_user&.public_ref,
      total_cents: order.total_cents,
      total_amount: order.total_amount,
      currency: order.currency,
      paid_at: order.paid_at&.to_i,
      items: order.items.map do |item|
        {
          sku: item.sku,
          name: item.name.presence || item.sku,
          quantity: item.quantity,
          image_url: item.product ? helpers.asset_path(item.product.image_name) : nil
        }
      end
    }
  end

  def render_error(message, status = :unprocessable_content)
    render json: { error: message }, status: status
  end
end
