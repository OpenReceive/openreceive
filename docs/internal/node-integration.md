# Node integration details

Use this page when the [Node quickstart](../guides/quickstart-node.md) is not enough.
Most apps should mount `@openreceive/express` (or Fastify/Next). They keep host policy in
`createHost({ db, amountFor, onPaid })` plus the host's
`authorize` policy.

## Request flow

```text
browser
  POST /orders { cart }
      │
      ▼
host validates cart, calculates exact price, creates order row
      │
      └── response { reference }

browser renders <Checkout reference={reference} />
      │
      ▼
POST /openreceive/checkouts/prepare { reference }        (prepare: no invoice yet)
      │
      ├── authorize(request, action, reference)
      ├── amountFor → authoritative amount
      └── response { amount_msats, fiat_quote?, payment_methods }

payer picks a method (Bitcoin → mint; swap asset → POST /openreceive/swaps)
      │
      ▼
POST /openreceive/checkouts { reference }                (mint)
      │
      ├── authorize(request, action, reference)
      ├── amountFor → authoritative amount
      ├── create or reuse the committed attempt (library-owned selection)
      ├── commitAttempt → transactional openreceive_payments insert
      └── response exposes payer instructions only after commit succeeds

later status refresh or reconcile pass
      │
      ├── authorize again (mounted routes)
      ├── library verifies { reference, payment_hash } selects a committed attempt
      ├── OpenReceive verifies the receive wallet (batched list_transactions)
      └── settled → write-once settlement transaction → onPaid for the first settled attempt
```

## Host integration

Mounted browser routes receive one `host` object. In the default `db` mode, the host supplies
only these:

| Option           | Host responsibility                                        |
| ---------------- | ---------------------------------------------------------- |
| `db`             | Handle to the existing database holding `openreceive_payments` |
| `amountFor`      | Authoritative `{ sats }` or `{ currency, value }` price, or `null` → 404 |
| `onPaid`         | In-transaction fulfillment for the first settled attempt   |

The library owns attempt selection, the commit lock per reference, the status state machine,
write-once settlement, and reconciliation transitions. `authorize` stays separate, on the
adapter. OpenReceive does not inspect the host session. It passes the Web-standard `Request`,
the requested action, and the order ID. Knowing an order ID is not authentication.

`onPaid({ reference, paymentHash, paidAt, details?, query })` runs inside the settlement
transaction. Use `query` to run statements (`?` placeholders) in that same transaction, for the
order update or an outbox insert. If a sibling attempt settles as a duplicate, it is recorded with
`status_reason = 'duplicate_settlement'` and never fulfills again.

The advanced form replaces `db` with `PaymentRepository<Transaction>`.
It implements:

- `listForReference`,
- `findByPaymentHash`,
- `listReconcilableAttempts`, paginated by keyset (a cursor on the last row seen),
- `commitAttempt`,
- `recordReconciliation`,
- `recordSettlementWithFulfillment(input, fulfill)`.

`recordSettlementWithFulfillment` holds the reference lock and writes settlement. It then awaits
`fulfill({ reference, paymentHash, paidAt, details?, transaction })` and commits both atomically.
A failure rolls back both writes. Legacy claims that return only a boolean are rejected before
use. Gated scans also require `claimReconcileGate` and `checkpointReconcileGate`, which own the
gate through a durable lease and compare-and-swap (CAS). If the hook itself refuses, the route
returns 409. If repository storage is down, it returns a retryable 503. Both withhold payer
instructions.

See [Payment storage](../guides/storage.md), [Node ORM recipes](../guides/node-orms.md), and
[Authorization](../guides/authorization.md).

## Settlement and reconciliation

Opportunistic reconcile is the default. Every mounted payment route runs one gated
`reconcileHostPayments` pass when attempts are pending. The durable `openreceive_meta` gate
makes these passes run one at a time across instances. The unauthenticated `GET /rates` never
triggers a pass.

- `maybeReconcilePayments({ service, host })` exposes the same gated pass for host-owned routes
  and middleware.
- The optional `startNotificationWorker` listens for notifications and runs the periodic pass,
  in one separate process.

Each pass loads only `pending` attempts and issues one batched `list_transactions` scan. It never
does one lookup per invoice. The scan window therefore stays close to the window of active
invoices, and no durable cursor exists. Delivery is at-least-once, and the settlement
transaction makes replays harmless.

Final settlement always requires `settled_at` or wallet state `settled`, never a preimage.
Suppose a notification carries that signal for a known pending attempt. It settles the attempt
directly through the write-once path, with no extra scan for that invoice. A notification
without the signal, or for an unknown hash, only wakes a bounded scan.

Terminal transitions (`expired`, `failed`, `attention` plus `status_reason`) require a
successful wallet scan. To close an unpaid attempt, that scan must also happen at or
after `expires_at + OPENRECEIVE_ATTEMPT_EXPIRY_GRACE_SECONDS` (900). Vectors:
`spec/test-vectors/attempt-reconciliation.json`. On shutdown, stop the notifications worker, if
you run one, before `service.close()`.

## Retries, concurrency, and expired invoices

- If the order has no live attempt for the requested rail/asset, OpenReceive creates one and
  commits it before responding.
- A retry reuses a live attempt if it has more than the reuse buffer (60 s) of life left.
- A same-rail attempt near expiry is superseded (`status_reason = 'superseded'`). It stays
  `pending`, so a late payment to it still reconciles. It closes only on a wallet scan.
- Concurrent creates run one at a time per reference inside the library repository. The loser
  receives `409` and no invoice.
- A payer can hold one live Lightning attempt and one live swap attempt per asset, so they can
  switch methods. The first wallet settlement fulfills.
- Status polling never creates a new invoice. When all attempts are terminal, a create request
  appends another row. Historical hashes are kept, so a late settlement updates the exact
  attempt the payer originally saw.

## Direct server-side checkout

For a server-rendered flow that does not use the mounted browser routes, call the service
directly. Commit through the host's library-owned repository before you display anything:

```ts
const checkout = await service.createCheckout({
  reference: order.id,
  amount: {
    currency: order.currency,
    value: order.total.toString(),
  },
});

await host.payments.commitAttempt({
  reference: order.id,
  paymentHash: checkout.paymentHash,
  checkout,
});

return checkout;
```

To recover on retry, return the selected attempt's stored `checkout` snapshot
from `host.payments.listForReference`. Full custom-controller patterns are in
[Writing your own checkout route](../guides/custom-checkout-route.md).

## Mounted routes

The default prefix is `/openreceive`. The route set is defined by
[`spec/openapi/openreceive-http.v1.yaml`](../../spec/openapi/openreceive-http.v1.yaml).
The generated route, body, and error tables are in the
[API reference](../guides/api-reference.md#framework-adapters). The route
list is in [Shipped routes](shipped-routes.md). Do not recreate these routes in
the application.
