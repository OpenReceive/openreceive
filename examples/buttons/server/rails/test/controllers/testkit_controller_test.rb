# frozen_string_literal: true

require "test_helper"
require Rails.root.join("lib/button_shop/testkit")

# The test-only control surface exists only in testkit wallet mode.
#
# THE OFF STATE IS THE ASSERTION HERE. The route is declared unconditionally,
# so the only thing standing between a production boot and a surface that can
# settle invoices is `ButtonShop::Testkit.enabled?` — and the test environment
# does not set DEMO_WALLET, which makes this suite the honest place to prove it.
class TestkitControllerTest < ActionDispatch::IntegrationTest
  test "DEMO_WALLET is not set in the test environment" do
    refute ButtonShop::Testkit.enabled?
  end

  test "every action is a JSON 404 outside testkit wallet mode" do
    %w[settle expire swap-step state].each do |action|
      post "/__testkit/#{action}", params: { payment_hash: "a" * 64 }, as: :json

      assert_response :not_found, "#{action} answered #{response.status}"
      assert_equal "NOT_FOUND", json_body.fetch("code")
      # JSON, never the SPA shell: a control surface that answered with a page
      # would look like a route that exists.
      assert_equal "application/json", response.media_type
    end
  end

  test "an unknown action is a 404 rather than a routing error" do
    get "/__testkit/state"

    assert_response :not_found
  end

  test "the control dispatcher refuses every action when the mode is off" do
    status, body = ButtonShop::Testkit.control("settle", { "payment_hash" => "a" * 64 })

    assert_equal 404, status
    assert_equal "NOT_FOUND", body.fetch("code")
  end

  private

  def json_body
    JSON.parse(response.body)
  end
end
