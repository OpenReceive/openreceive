# Node integration details

Use this when the [Node quickstart](../guides/quickstart-node.md) is not enough.
Most apps should mount `@openreceive/express` (or Fastify/Next) and keep host policy in
one generated host integration plus the host's `authorize` policy.

## Request flow

```text
browser
  POST /orders { cart }
      │
      ▼
host validates cart, calculates exact price, creates order row
      │
      └── response { order_id }

browser renders <Checkout orderId={order_id} />
      │
      ▼
POST /openreceive/checkouts { order_id }
      │
      ├── authorize(request, action, order_id)
      ├── resolveCheckout(order_id) → amount + live payment attempt, if any
      ├── create or reuse the host-stored checkout snapshot
      ├── onCheckoutCreated(...) → atomic host database commit
      └── response exposes payer instructions only after commit succeeds

later status refresh
      │
      ├── authorize again
      ├── host verifies { order_id, payment_hash } selects its payment row
      ├── OpenReceive verifies the receive wallet
      └── settled payment → onPaid({ paymentHash, paidAt })
```

## Host integration

Mounted browser routes receive one `host` object containing:

| Hook                | Host responsibility                                              |
| ------------------- | ---------------------------------------------------------------- |
| `authorize`         | May this request act on this order?                              |
| `resolveCheckout`   | What is the order amount and which payment attempt was selected? |
| `onCheckoutCreated` | Did the host atomically commit this new payment attempt?         |
| `onPaid`            | Did the host durably record this verified settlement?            |

OpenReceive does not inspect the host session. It passes the Web-standard `Request`,
requested action, and order ID to `authorize`. Knowing an order ID is not authentication;
anonymous checkout apps use their own signed guest cookie or another host-owned access
mechanism.

Build it with `createOpenReceiveHost`:

```ts
import { createOpenReceiveHost } from "@openreceive/http";

const host = createOpenReceiveHost({
  loadOrder: (orderId) => orders.find(orderId),
  amountForOrder: (order) => ({
    currency: order.currency,
    value: order.total.toString(),
  }),
  payments: paymentRepository,
  onPaid: ({ paymentHash, paidAt }) =>
    paymentRepository.markPaidOnceAndFulfillFirst(paymentHash, paidAt),
});
```

`paymentRepository` implements `listForOrder(orderId)` and `commitAttempt(input)`. The commit
transaction locks the existing order row, rejects another paid or live attempt, and inserts
the new payment row. If it throws, OpenReceive returns `409` and withholds the new payer
instructions.

Payment checks, swap status, and refunds carry `order_id` plus the displayed `payment_hash`.
The helper verifies that the selected attempt belongs to that order before returning
server-only `swapData`.

See `npx openreceive scaffold payments` or [Node ORM Recipes](../guides/node-orms.md) for
schemas and lock queries. Policy detail lives in [Authorization](../guides/authorization.md).

## Settlement (`onPaid`)

`onPaid` receives wallet-verified settlement. Look up the payment attempt by hash, set its
`paid_at` only when null, lock the related order, and fulfill only when no sibling attempt
was already paid.

`onPaid` may be delivered more than once. Host `markPaidOnce` must be idempotent and return
successfully for unknown hashes because a receive wallet may contain unrelated invoices. A
wallet notification is only a hint to refresh state; final settlement requires `settled_at`
or a wallet transaction state of `settled`.

## Retries, concurrency, and expired invoices

- If the order has no live payment row, OpenReceive creates an attempt and asks the host to
  commit it.
- If the order already has one live attempt, retries reuse its stored checkout.
- If concurrent requests create different invoices, only the transaction that first locks the
  host order and inserts its row may expose its invoice. The losing request receives `409`.
- Status polling never creates a new invoice.
- When all unpaid attempts are expired or terminal, a create request may append another row
  for the same order.
- Keep historical hashes: a late settlement always updates the exact attempt originally
  exposed.

## Direct server-side checkout

For a server-rendered flow that does not use mounted browser routes, call the service
directly and commit before display:

```ts
const checkout = await service.createCheckout({
  orderId: order.id,
  amount: {
    currency: order.currency,
    value: order.total.toString(),
  },
});

await payments.commitAttempt({
  orderId: order.id,
  paymentHash: checkout.paymentHash,
  checkout,
});

return checkout;
```

For retry recovery, return the selected attempt's required `checkout_data` snapshot. Full
custom-controller patterns are in
[Custom Controller Integration](custom-controller-integration.md).

## Mounted routes

Default prefix is `/openreceive`:

| Route                              | Purpose                                          |
| ---------------------------------- | ------------------------------------------------ |
| `POST /openreceive/checkouts`      | Create or recover the order's Lightning checkout |
| `POST /openreceive/payments/check` | Refresh wallet settlement for the order          |
| `POST /openreceive/swaps/quote`    | Quote a host-priced swap                         |
| `POST /openreceive/swaps`          | Create or recover a swap                         |
| `POST /openreceive/swaps/status`   | Refresh provider state                           |
| `POST /openreceive/swaps/refunds`  | Request an eligible refund                       |
| `GET /openreceive/rates`           | Read configured BTC/fiat rates                   |

Do not recreate these routes in the application.
