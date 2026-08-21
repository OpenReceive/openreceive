# frozen_string_literal: true

require "test_helper"

class PublicCacheHeadersTest < ActiveSupport::TestCase
  test "content-hashed files are immutable" do
    assert_equal HelloFruit::PublicCacheHeaders::IMMUTABLE,
                 HelloFruit::PublicCacheHeaders.cache_control_for(
                   "/packs/js/hello_fruit-c269d2dc424d66727757.js"
                 )
    assert_equal HelloFruit::PublicCacheHeaders::IMMUTABLE,
                 HelloFruit::PublicCacheHeaders.cache_control_for(
                   "/packs/css/hello_fruit-e48ba324.css"
                 )
    assert_equal HelloFruit::PublicCacheHeaders::IMMUTABLE,
                 HelloFruit::PublicCacheHeaders.cache_control_for("/assets/hello_fruit-a1b2c3d4.js")
  end

  test "the HTML shell is never cached" do
    assert_equal HelloFruit::PublicCacheHeaders::NO_STORE,
                 HelloFruit::PublicCacheHeaders.cache_control_for("/")
    assert_equal HelloFruit::PublicCacheHeaders::NO_STORE,
                 HelloFruit::PublicCacheHeaders.cache_control_for("/index.html")
    assert_equal HelloFruit::PublicCacheHeaders::NO_STORE,
                 HelloFruit::PublicCacheHeaders.cache_control_for("/checkout/rails-order-1")
    assert_equal HelloFruit::PublicCacheHeaders::NO_STORE,
                 HelloFruit::PublicCacheHeaders.cache_control_for("/404.html")
  end

  test "unhashed public files revalidate" do
    assert_equal HelloFruit::PublicCacheHeaders::REVALIDATE,
                 HelloFruit::PublicCacheHeaders.cache_control_for("/packs/js/assets/icons/lightning.svg")
    assert_equal HelloFruit::PublicCacheHeaders::REVALIDATE,
                 HelloFruit::PublicCacheHeaders.cache_control_for("/packs/manifest.json")
    assert_equal HelloFruit::PublicCacheHeaders::REVALIDATE,
                 HelloFruit::PublicCacheHeaders.cache_control_for("/icon.png")
    assert_equal HelloFruit::PublicCacheHeaders::REVALIDATE,
                 HelloFruit::PublicCacheHeaders.cache_control_for("/stickers/apple.svg")
  end

  test "API routes are left alone" do
    assert_nil HelloFruit::PublicCacheHeaders.cache_control_for("/orders")
    assert_nil HelloFruit::PublicCacheHeaders.cache_control_for("/openreceive/payments/check")
    assert_nil HelloFruit::PublicCacheHeaders.cache_control_for("/rates")
  end
end
