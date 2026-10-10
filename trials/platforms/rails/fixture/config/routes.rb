Rails.application.routes.draw do
  root "catalog#index"
  resources :orders, only: [:create, :show]
  get "/health", to: "catalog#health"
end
