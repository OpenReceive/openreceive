# frozen_string_literal: true

# GET /shop/recent_orders is a new UNAUTHENTICATED endpoint that runs a query,
# so it gets a per-IP cap. The ten-second public cache header on the response
# does most of the work already; this is the backstop for a client that ignores
# it.
#
# The engine's own routes are capped separately, by `config.rate_limiting = true`
# in config/initializers/openreceive.rb, counted from the openreceive_payments
# rows rather than from a cache — a different mechanism for a different resource.
Rack::Attack.throttle("shop/recent_orders", limit: 30, period: 1.minute) do |request|
  request.ip if request.get? && request.path == "/shop/recent_orders"
end

# Rack::Attack needs somewhere to count. The memory store is per-process, which
# under multiple Puma workers means the effective limit is (limit × workers) —
# fine for a demo, and the alternative is asking this example to run Redis.
Rack::Attack.cache.store = ActiveSupport::Cache::MemoryStore.new
