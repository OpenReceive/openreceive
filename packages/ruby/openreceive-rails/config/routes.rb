# frozen_string_literal: true

# Engine routes — the shipped @openreceive/http contract (spec/openapi/openreceive-http.v1.yaml),
# mounted by the host with `mount OpenReceive::Engine => "/openreceive"`.
#
# `format: false` and the `[^/]+` constraints let order_id / checkout_id contain dots and other
# characters (matching RackApp's raw path-segment routing); Rails still stops each segment at `/`.
OpenReceive::Engine.routes.draw do
  post "checkouts", to: "checkouts#create"
  get "checkouts/:checkout_id", to: "checkouts#show",
      constraints: { checkout_id: %r{[^/]+} }, format: false

  post "orders/:order_id", to: "orders#perform",
       constraints: { order_id: %r{[^/]+} }, format: false
  get "orders/:order_id/swap-options", to: "orders#swap_options",
      constraints: { order_id: %r{[^/]+} }, format: false

  get "rates", to: "rates#index"

  post "admin/sweep", to: "admin#sweep"
end
