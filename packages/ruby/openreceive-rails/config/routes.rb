# frozen_string_literal: true

# Engine routes — the shipped @openreceive/http contract (spec/openapi/openreceive-http.v1.yaml),
# mounted by the host with `mount OpenReceive::Engine => "/openreceive"`.
#
# `format: false` and the `[^/]+` constraints let order_id / checkout_id contain dots and other
# characters (matching RackApp's raw path-segment routing); Rails still stops each segment at `/`.
OpenReceive::Engine.routes.draw do
  post "checkouts", to: "checkouts#create"
  post "payments/check", to: "payments#check"
  post "swaps/quote", to: "swaps#quote"
  post "swaps", to: "swaps#create"
  post "swaps/status", to: "swaps#status"
  post "swaps/refund-confirmations", to: "swaps#refund_confirmation"
  post "swaps/refunds", to: "swaps#refund"

  get "rates", to: "rates#index"
end
