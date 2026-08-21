# frozen_string_literal: true

Rails.application.routes.draw do
  mount OpenReceive::Engine => "/openreceive"

  root "home#index"
  resources :orders, only: %i[create show]

  get "up" => "rails/health#show", as: :rails_health_check
end
