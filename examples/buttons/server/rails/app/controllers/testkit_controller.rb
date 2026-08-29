# frozen_string_literal: true

require Rails.root.join("lib/button_shop/testkit")

# The test-only control surface, mounted at /__testkit in testkit wallet mode
# and a hard JSON 404 in every other mode — see lib/button_shop/testkit.rb for
# what it drives and why the Rails stack needed its own.
#
# It does NOT inherit ShopIdentity: settling an invoice is a wallet event, and
# minting a visitor row for a control call would put junk in the feed the demo
# is about. CSRF is skipped for the same reason `curl` has to be able to drive
# it — the surface does not exist unless the process was booted for tests.
class TestkitController < ActionController::Base
  skip_forgery_protection

  def control
    status, body = ButtonShop::Testkit.control(params[:control].to_s, control_params)
    response.headers["Cache-Control"] = "no-store"
    render json: body, status: status
  end

  private

  # `params` carries Rails' own :controller/:action/:control keys; the control
  # surface reads a plain string-keyed hash, exactly as the Node one reads a
  # parsed JSON body.
  def control_params
    params.to_unsafe_h.except("controller", "action", "control", "testkit").stringify_keys
  end
end
