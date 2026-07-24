# Authorization and host integration

OpenReceive never inspects your session. Mounted Node handlers require:

- `authorize(context)`: your authentication/ownership policy;
- `host`: one `OpenReceiveHost` containing trusted order pricing, the payment-attempt
  repository, and replay-safe `onPaid`.

`rateLimit` is optional. OpenReceive does not ship a permissive authorization default. Supply
the host application's normal session, account, or guest-order ownership policy; return false
when the authenticated caller does not own the requested order.

The create body cannot contain `amount` or `amount_msats`. This prevents a browser from being
the price authority. A failed attempt commit returns 409 without invoice or swap payer
instructions.

Payment checks, swap status, and refunds send `order_id` plus the displayed `payment_hash`.
After authorization, the host must verify that hash belongs to the order before loading optional
server-only `swap_data`. The hash is an attempt selector, not an authorization capability.
