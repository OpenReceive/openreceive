# Shipped routes

The exact route contract is `spec/openapi/openreceive-http.v1.yaml`. Node adapters and the
Rails engine expose checkout creation, payment checks, swap quote/create/status/refund, and
rates. There are no prepare, order-storage, checkout-read, migration, admin-sweep, or internal
workflow routes.

Construction requires host `authorize`, amount resolution, and checkout-commit hooks. The
amount resolver runs from host-owned data. The commit hook runs after external invoice/provider
creation but before the response; failure returns 409 and withholds payer instructions.

Payment/swap reads send `order_id`. The host authorizes the request and resolves its stored
`payment_hash` / `swap_data`; OpenReceive mints no browser capability.
