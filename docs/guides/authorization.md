# Authorization and the order bridge

OpenReceive never inspects your session. The happy path is the all-in-one
adapter factory: your order hooks plus a database handle, and your
authorization policy. The adapter builds the wallet client and the order
bridge itself:

```ts
import { openReceiveExpress } from "@openreceive/express";

app.use(openReceiveExpress({
  wallet: { nwc: process.env.NWC_URI! }, // receive-only; your app refuses to start otherwise
  storage: {
    db, // your existing database handle
    onPaid: async ({ orderId, query }) => {
      // Settlement transaction; runs only for the order's first settled attempt.
      await query("UPDATE orders SET state = 'paid' WHERE id = ?", [orderId]);
    },
  },
  loadOrder: (orderId) => orders.find(orderId),
  amountForOrder: (order) => ({ currency: "USD", value: order.total.toString() }),
  authorize: async ({ action, request, resource }) =>
    orders.viewerMay(await sessions.currentUser(request), resource.orderId, action),
}));
```

`authorize(context)` is your authentication/ownership policy and runs on every
order-scoped request. OpenReceive does not ship a permissive authorization
default. Supply your application's normal session, account, or guest-order
ownership policy; return false when the authenticated caller does not own the
requested order. The optional `rateLimitHook` receives the same context; for
the common per-IP invoice cap prefer the one-line `rateLimiting` option
instead — see [Rate limiting](rate-limiting.md).

The context object:

- `action`: one of `checkout.prepare`, `checkout.create`, `payment.check`, `swap.quote`,
  `swap.create`, `swap.read`, `swap.refund`.
- `request`: the web-standard `Request`.
- `resource`: `{ orderId?, paymentHash? }` — untrusted payer-supplied selectors; possession
  is not ownership.
- `native`: the untouched framework-native request when an adapter provides one — use it for
  middleware-attached session/user state. Express:

  ```ts
  authorize: ({ native, resource }) =>
    orders.ownedBy((native as { session?: { userId?: string } }).session?.userId, resource.orderId)
  ```

Rails applications mount the engine and keep their own authentication and
`current_user` logic. The engine's JSON checkout routes skip Rails form CSRF
protection, so `authorize` is the auth boundary there too.

`loadOrder` returns your order (or `null` → 404). `amountForOrder` returns the
authoritative `{ sats }` or `{ currency, value }` price from that order. The create body cannot
contain `amount` or `amount_msats` — your application resolves the price, so a payer-supplied amount
could only ever be an attempt to pay less (or trick support with an overpaid receipt); the
route rejects it outright. A
failed attempt commit withholds invoice and swap payer instructions.

Payment checks, swap status, and refunds send `order_id` plus the displayed `payment_hash`.
After authorization, the library verifies that hash belongs to the order before loading optional
server-only `swap_data`. The hash is an attempt selector, not an authorization capability.

## Advanced: composing the pieces

When you need a shared wallet client, a custom payments repository, or direct
handler tests, build the pieces yourself and pass the composed form to the
same adapter:

```ts
import { createOpenReceive } from "@openreceive/node";
import { createHost } from "@openreceive/http";

const service = await createOpenReceive();
const host = createHost({ db, loadOrder, amountForOrder, onPaid });

app.use(openReceiveExpress({ service, host, authorize }));
```

The mounted routes still commit the attempt row before any payer instructions
are exposed — `host.onCheckoutCreated` runs between the wallet mint and the
HTTP response, and a refused commit returns `409` (infrastructure failure:
retryable `503`) with the invoice withheld. Only a fully custom server-side
flow bypasses that wiring, and then the commit step is yours:

```ts
const checkout = await service.createCheckout({ orderId: order.id, amount });
await host.payments.commitAttempt({
  orderId: order.id,
  paymentHash: checkout.paymentHash,
  checkout,
}); // commit BEFORE the payer sees the invoice
```

See [createHost](api-reference.md#createhost) and
[Payment storage](storage.md) for the repository escape hatch.
