# frozen_string_literal: true

Rails.application.routes.draw do
  # The engine. One mount is the whole of what the browser packages need to
  # reach every OpenReceive route; the SPA hydrates the prefix from the
  # bootstrap payload rather than keeping a second copy of this string.
  mount OpenReceive::Engine => "/openreceive"
  # Settlement pushes (solid_cable). Polling stays the baseline transport: the
  # feed keeps a slow safety-net poll and the checkout keeps its own, so a
  # dropped websocket costs latency and never correctness.
  mount ActionCable.server => "/cable"

  root "shop#index"

  # The checkout's own URL. A payer with a swap deposit in flight has no
  # account and no email from us — this path is the only thing that brings them
  # back to their payment screen, so it has to survive a hard reload and a
  # bookmark. It renders the SAME SPA shell as the root: the client reads the
  # uuid off `location.pathname` and asks `shop#show_order` for the summary,
  # which is the route that decides whether this browser may see it.
  get "checkout/:reference", to: "shop#index",
      constraints: { reference: /\h{8}-\h{4}-\h{4}-\h{4}-\h{12}/ }

  # The shop's own JSON API. OpenReceive owns none of it.
  #
  # The uuid constraints are not decoration: these are anonymous routes, and a
  # malformed uuid literal raises in Postgres before any of our code sees it.
  # Format-check untrusted input BEFORE it reaches the database.
  post "shop/orders", to: "shop#create_order"
  get "shop/orders/:id", to: "shop#show_order",
      constraints: { id: /\h{8}-\h{4}-\h{4}-\h{4}-\h{12}/ }, as: :shop_order
  get "shop/orders/:id/downloads/:sku", to: "shop#download",
      constraints: { id: /\h{8}-\h{4}-\h{4}-\h{4}-\h{12}/, sku: /[a-z]+(?:-[a-z]+)*/ },
      as: :shop_order_download
  get "shop/recent_orders", to: "shop#recent_orders", as: :shop_recent_orders

  # The test-only control surface. It is DECLARED unconditionally and refuses
  # unconditionally: `ButtonShop::Testkit.control` answers 404 for every action
  # unless DEMO_WALLET=testkit, so there is one place that decides whether the
  # surface exists and it is not the routing table. See lib/button_shop/testkit.rb.
  match "__testkit/:control", to: "testkit#control", via: %i[get post],
        constraints: { control: /[a-z-]+/ }

  get "up" => "rails/health#show", as: :rails_health_check
end
