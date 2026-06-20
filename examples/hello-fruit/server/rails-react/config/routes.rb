Rails.application.routes.draw do
  root "hello_fruit#index"
  get "/healthz", to: "hello_fruit#health"
  get "/demo-metadata.json", to: "hello_fruit#metadata"

  mount OpenReceive::Rails::Engine => "/openreceive"
end
