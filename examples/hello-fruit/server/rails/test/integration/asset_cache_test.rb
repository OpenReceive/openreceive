# frozen_string_literal: true

require "test_helper"

class AssetCacheTest < ActionDispatch::IntegrationTest
  include HelloFruitTestSetup

  setup { ensure_hello_fruit_assets! }

  test "the SPA shell uses Shakapacker pack tags and is not cached" do
    get "/"
    assert_response :success
    assert_includes response.headers["Cache-Control"], "no-store"
    assert_match %r{/packs-test/js/hello_fruit-[0-9a-f]+\.js}, response.body
    assert_match %r{/packs-test/css/hello_fruit-[0-9a-f]+\.css}, response.body
  end

  test "the SPA shell embeds the app bootstrap blob" do
    seed_catalog!
    get "/"
    assert_response :success
    assert_includes response.body, '<div id="root"></div>'
    assert_includes response.body, '<script id="__app_bootstrap" type="application/json">'
  end

  test "checkout resume HTML is not cached" do
    get "/checkout/rails-order-1"
    assert_response :success
    assert_includes response.headers["Cache-Control"], "no-store"
  end

  test "digested pack javascript is cached immutably" do
    get "/"
    src = response.body[%r{src="(/packs-test/js/hello_fruit-[0-9a-f]+\.js)"}, 1]
    assert src, "expected a digested hello_fruit script tag"
    get src
    assert_response :success
    assert_includes response.headers["Cache-Control"], "immutable"
  end

  test "unhashed runtime images under the pack output revalidate" do
    file = Rails.public_path.join("packs-test/js/assets/icons/test-icon.svg")
    FileUtils.mkdir_p(file.dirname)
    file.write("<svg xmlns='http://www.w3.org/2000/svg'/>")
    begin
      get "/packs-test/js/assets/icons/test-icon.svg"
      assert_response :success
      assert_equal HelloFruit::PublicCacheHeaders::REVALIDATE, response.headers["Cache-Control"]
    ensure
      file.delete if file.file?
    end
  end
end
