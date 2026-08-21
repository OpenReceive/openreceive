# frozen_string_literal: true

Rails.application.routes.draw do
  mount OpenReceive::Engine => "/openreceive"
  # Settlement pushes (solid_cable). Polling stays the baseline transport.
  mount ActionCable.server => "/cable"

  root "shop#index"
  get "checkout/:order_id", to: "shop#index"

  resources :orders, only: %i[create show]
  get "rates", to: "rates#index"
  get "delivery/:order_id/:product_id", to: "deliveries#show", as: :delivery

  get "up" => "rails/health#show", as: :rails_health_check
end
