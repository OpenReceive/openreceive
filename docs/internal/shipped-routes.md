# Shipped routes

The exact route contract is `spec/openapi/openreceive-http.v1.yaml`. Node adapters and the
Rails engine expose checkout creation, payment checks, swap quote/create/status/refund, and
rates. There are no prepare, order-storage, checkout-read, migration, admin-sweep, or internal
workflow routes.

Construction requires host `authorize` plus one host integration containing trusted amount
resolution, attempt persistence, and replay-safe settlement. Attempt persistence runs after
external invoice/provider creation but before the response; failure returns 409 and withholds
payer instructions.

Payment/swap reads send `order_id` plus `payment_hash`. The host authorizes the request, verifies
the selected attempt belongs to the order, and resolves its server-only `swap_data`;
OpenReceive mints no browser capability.
