# Authorization and host hooks

OpenReceive never inspects your session. Mounted handlers require:

- `authorize(context)`: your authentication/ownership policy;
- `resolveCheckout(context)`: load the host order's amount, payment hash, and optional swap data;
- `onCheckoutCreated(payment)`: compare-and-set `payment_hash` before responding.

`rateLimit` is optional. OpenReceive does not ship a permissive authorization default. Supply
the host application's normal session, account, or guest-order ownership policy; return false
when the authenticated caller does not own the requested order.

The create body cannot contain `amount` or `amount_msats`. This prevents a browser from being
the price authority. A failed `onCheckoutCreated` returns 409 without invoice or swap payer
instructions.

Payment checks, swap status, and refunds send only `order_id`. After authorization, the host
resolver loads `payment_hash` and optional server-only `swap_data`; neither becomes a
browser-carried OpenReceive capability.
