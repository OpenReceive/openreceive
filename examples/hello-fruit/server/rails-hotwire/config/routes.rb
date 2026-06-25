Rails.application.routes.draw do
  root "hello_fruit#index"
  get "/demo-metadata.json", to: "hello_fruit#metadata"
  post "/create_order", to: "hello_fruit#create_order"
  post "/order_status", to: "hello_fruit#order_status"
end
