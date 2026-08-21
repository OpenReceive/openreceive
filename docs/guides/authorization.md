# Authorization and host integration

OpenReceive never inspects your session. Mounted Node handlers require:

- `authorize(context)`: your authentication/ownership policy;
- `host`: built with `createOpenReceiveHost({ db, loadOrder, amountForOrder, onPaid })` —
  your database handle, trusted order loading and pricing, and the in-transaction
  fulfillment hook. The library owns attempt persistence and settlement.

`rateLimit` is optional; for the common per-IP invoice cap prefer the one-line `rateLimiting`
option instead — see [Rate limiting](rate-limiting.md). OpenReceive does not ship a permissive
authorization default. Supply the host application's normal session, account, or guest-order
ownership policy; return false when the authenticated caller does not own the requested order.

`authorize` (and `rateLimit`) receive one context object:

- `action`: one of `checkout.prepare`, `checkout.create`, `payment.check`, `swap.quote`,
  `swap.create`, `swap.read`, `swap.refund`.
- `request`: the web-standard `Request`.
- `resource`: `{ order_id?, payment_hash? }` — untrusted payer-supplied selectors; possession
  is not ownership.
- `native`: the untouched framework-native request when an adapter provides one — use it for
  middleware-attached session/user state. Express:

  ```ts
  authorize: ({ native, resource }) =>
    orders.ownedBy((native as { session?: { userId?: string } }).session?.userId, resource.order_id)
  ```

`loadOrder` returns the host order (or `null` → 404). `amountForOrder` returns the
authoritative `{ sats }` or `{ currency, value }` price from that order. The create body cannot
contain `amount` or `amount_msats` — pricing is host-resolved, so a payer-supplied amount
could only ever be an attempt to pay less (or trick support with an overpaid receipt); the
route rejects it outright. A
failed attempt commit withholds invoice and swap payer instructions.

Payment checks, swap status, and refunds send `order_id` plus the displayed `payment_hash`.
After authorization, the library verifies that hash belongs to the order before loading optional
server-only `swap_data`. The hash is an attempt selector, not an authorization capability.
