ENV["RAILS_ENV"] = "test"
ENV["DATABASE_URL"] = "sqlite3:/tmp/widget-shop-test.sqlite3"
require_relative "../config/environment"
require "minitest/autorun"
require "rack/mock"

ActionController::Base.allow_forgery_protection = false

class ShopTest < Minitest::Test
  def shop
    @shop ||= Rack::MockRequest.new(Rails.application)
  end

  def visit(method, path, opts = {})
    shop.request(method, path, { "HTTP_HOST" => "localhost", "REMOTE_ADDR" => "127.0.0.1" }.merge(opts))
  end

  def test_home_lists_products
    response = visit("GET", "/")
    assert_equal 200, response.status
    assert_includes response.body, "Facet"
    assert_includes response.body, "Bezel"
  end

  def test_buyer_sees_their_order_and_a_stranger_does_not
    created = visit("POST", "/orders", params: { product_id: Product.find_by!(sku: "facet").id })
    assert_equal 303, created.status
    cookie = created.headers["set-cookie"].to_s.split(";").first
    order_path = URI(created.headers["location"]).path
    mine = visit("GET", order_path, "HTTP_COOKIE" => cookie)
    assert_equal 200, mine.status
    assert_includes mine.body, "Facet"
    theirs = visit("GET", order_path)
    assert_includes [401, 403, 404], theirs.status
  end
end
