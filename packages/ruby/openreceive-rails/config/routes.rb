# frozen_string_literal: true

# Engine routes — the shipped @openreceive/http contract (spec/openapi/openreceive-http.v1.yaml),
# mounted by the host with `mount OpenReceive::Engine => "/openreceive"`.
OpenReceive::Engine.routes.draw do
  post "checkouts", to: "checkouts#create"
  post "payments/check", to: "payments#check"
  post "swaps/quote", to: "swaps#quote"
  post "swaps", to: "swaps#create"
  post "swaps/status", to: "swaps#status"
  post "swaps/refunds", to: "swaps#refund"

  get "rates", to: "rates#index"
end
