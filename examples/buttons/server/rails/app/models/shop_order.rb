# frozen_string_literal: true

# One cart checkout. The id IS the OpenReceive `reference`: created before
# checkout, kept across every retry, never reused, and unguessable because it is
# a uuid rather than a sequential integer.
#
# OpenReceive never sees this model. The three hooks in
# config/initializers/openreceive.rb are the only bridge:
#   authorize   -> shop_user_id vs. the signed cookie
#   amount_for  -> total_amount / checkout_description, below
#   on_paid     -> claim_paid!, below
class ShopOrder < ApplicationRecord
  AWAITING_PAYMENT = "awaiting_payment"
  PAID = "paid"
  STATES = [AWAITING_PAYMENT, PAID].freeze

  UUID_PATTERN = /\A\h{8}-\h{4}-\h{4}-\h{4}-\h{12}\z/

  # How many rows the public feed shows, and the only limit it honours.
  FEED_LIMIT = 25

  belongs_to :shop_user, inverse_of: :shop_orders

  has_many :items, -> { order(:created_at) },
           class_name: "ShopOrderItem", dependent: :destroy, inverse_of: :shop_order

  validates :state, inclusion: { in: STATES }
  validates :total_cents, numericality: { only_integer: true, greater_than: 0 }

  scope :paid, -> { where(state: PAID) }
  # Newest paid first, with users and items preloaded — the feed is an N+1 by
  # default and this is a demo people read.
  scope :recent, -> { paid.order(paid_at: :desc, created_at: :desc) }

  # The reference arrives as a string the payer's browser sent. Postgres RAISES
  # on a malformed uuid, so the format check happens before the query — every
  # caller here is on a request path an anonymous payer can reach.
  def self.find_by_reference(reference)
    return nil unless reference.is_a?(String) && reference.match?(UUID_PATTERN)

    find_by(id: reference)
  end

  # One transaction: the order and every item, with the totals summed from the
  # PRODUCT rows the controller looked up. Nothing here reads a number the
  # browser sent.
  #
  # The name and unit price are copied onto the item deliberately — see
  # ShopOrderItem for why history must not move when the catalog does.
  def self.create_from_lines!(lines, shop_user:)
    transaction do
      order = create!(
        shop_user: shop_user,
        state: AWAITING_PAYMENT,
        currency: "USD",
        total_cents: lines.sum { |line| line.fetch(:product).price_cents * line.fetch(:quantity) }
      )

      lines.each do |line|
        product = line.fetch(:product)
        order.items.create!(
          product: product,
          sku: product.sku,
          name: product.name,
          unit_price_cents: product.price_cents,
          quantity: line.fetch(:quantity)
        )
      end

      order
    end
  end

  def paid?
    state == PAID
  end

  # The settlement push, on two streams: this payer's own order, and the public
  # feed every visitor watching the Recent orders tab is subscribed to.
  #
  # NEVER call this from `config.on_paid`. That hook runs INSIDE the settlement
  # transaction, where the rule is database writes only — a broadcast sent from
  # there would survive a rollback and tell every browser about an order that
  # does not exist. The initializer schedules it with
  # `ActiveRecord.after_all_transactions_commit` instead, and there is a test
  # that rolls the transaction back and asserts silence.
  #
  # Best-effort by construction: a dropped broadcast costs latency, never
  # correctness, because both the feed and the checkout keep polling.
  def broadcast_settled!
    ShopOrderChannel.broadcast_paid(id)
    ShopFeedChannel.broadcast_orders_changed
  end

  # A decimal string for `config.amount_for`. Integers all the way down; the
  # division happens once, in the formatter. Never a float in a payload.
  def total_amount
    format("%.2f", total_cents / 100.0)
  end

  # What the payer is BUYING, in our own words — one display string, rendered
  # above the amount on every checkout screen. Without it the checkout is a QR
  # code and "$4.00" with no sign of what the four dollars is for, because
  # OpenReceive owns no line items and can show nothing else on its own.
  #
  # Built from the item SNAPSHOTS, so it reads the same after a catalog edit.
  def checkout_description
    parts = items.map do |item|
      label = item.name.presence || item.sku
      item.quantity > 1 ? "#{label} ×#{item.quantity}" : label
    end

    "OpenReceive #{'button'.pluralize(items.sum(&:quantity))}: #{parts.join(', ')}"
  end

  # THE GUARDED TRANSITION, idempotent by construction: the WHERE clause is the
  # lock. Whoever flips awaiting_payment -> paid first is the only one who
  # fulfills; a later attempt updates zero rows and does nothing. Returns true
  # when THIS call is the one that claimed the order.
  #
  # A class method, not an instance method, and `update_all` rather than
  # `update!`: one conditional UPDATE with no model code and no callbacks
  # between the check and the write. There is nowhere for a second caller to
  # squeeze in.
  #
  # OpenReceive already guarantees the settlement hook runs at most once per
  # reference across every path it owns. This is still written this way because
  # OpenReceive cannot see a second fulfillment path of OURS — an admin action,
  # a support tool, a replayed job — and the moment one exists, those race each
  # other rather than the library.
  def self.claim_paid!(reference:, paid_at:, payment_hash:)
    return false unless reference.is_a?(String) && reference.match?(UUID_PATTERN)

    claimed = where(id: reference, state: AWAITING_PAYMENT).update_all(
      state: PAID,
      paid_at: paid_at,
      payment_hash: payment_hash,
      updated_at: Time.current
    )

    claimed.positive?
  end
end
