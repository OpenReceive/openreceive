# frozen_string_literal: true

# Who this browser is. A signed cookie holding a ShopUser id, and nothing
# else — no email, no password, no account.
#
# Included by ShopController, which both renders the shop page and serves the
# shop's JSON API. NEVER by ApplicationController: minting a ShopUser for every
# asset, docs or health-check request is a junk-row generator, and the row is
# only meaningful on a page or a route that can place an order.
module ShopIdentity
  extend ActiveSupport::Concern

  COOKIE = :shop_user_id
  LIFETIME = 1.year

  included do
    helper_method :current_shop_user
  end

  def current_shop_user
    @current_shop_user ||= begin
      user = user_from_cookie || ShopUser.create!(
        first_seen_at: Time.current, last_seen_at: Time.current
      )
      # Rewritten on every shop request, which is what makes the year ROLLING:
      # a visitor who comes back inside twelve months never expires.
      write_identity_cookie(user)
      user.touch_seen!
      user
    end
  end

  private

  # `find_by`, never `find`: a cookie that outlives its row must degrade to a
  # new visitor, not to a 500 on the home page.
  #
  # A tampered or hand-written value fails the signature check and reads as
  # nil, landing in the same branch — which is exactly what makes a raw uuid
  # copied out of the public feed useless as a cookie.
  def user_from_cookie
    raw = cookies.signed[COOKIE]
    raw.present? ? ShopUser.find_by(id: raw) : nil
  end

  # SIGNED, always. This value is the ownership token for every order this
  # browser ever placed — it gates the download, and it is what
  # `config.authorize` checks before OpenReceive will mint an invoice.
  #
  # `secure` follows THE REQUEST, not the environment. Rails silently DROPS a
  # Set-Cookie marked secure on a plain-HTTP request (ActionDispatch::Cookies
  # #write_cookie?), so `Rails.env.production?` here meant the production-mode
  # Docker demo, served over http://localhost, minted a fresh ShopUser on every
  # request and every checkout 403'd in `config.authorize`. Behind TLS —
  # including a proxy, with `config.assume_ssl` set — `request.ssl?` is true and
  # the cookie is marked secure, which is the case that matters.
  def write_identity_cookie(user)
    cookies.signed[COOKIE] = {
      value: user.id,
      expires: LIFETIME.from_now,
      httponly: true,
      same_site: :lax,
      path: "/",
      secure: request.ssl?
    }
  end
end
