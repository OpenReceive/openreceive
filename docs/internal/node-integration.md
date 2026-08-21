# Node integration details

Use this when the [Node quickstart](../guides/quickstart-node.md) is not enough.
Most apps should mount `@openreceive/express` (or Fastify/Next) and keep host policy in
`createOpenReceiveHost({ db, loadOrder, amountForOrder, onPaid })` plus the host's
`authorize` policy.

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
POST /openreceive/checkouts/prepare { order_id }        (prepare: no invoice yet)
      │
      ├── authorize(request, action, order_id)
      ├── loadOrder + amountForOrder → authoritative amount
      └── response { amount_msats, fiat_quote?, payment_methods }

payer picks a method (Bitcoin → mint; swap asset → POST /openreceive/swaps)
      │
      ▼
POST /openreceive/checkouts { order_id }                (mint)
      │
      ├── authorize(request, action, order_id)
      ├── loadOrder + amountForOrder → authoritative amount
      ├── create or reuse the committed attempt (library-owned selection)
      ├── commitAttempt → transactional openreceive_payments insert
      └── response exposes payer instructions only after commit succeeds

later status refresh or reconcile pass
      │
      ├── authorize again (mounted routes)
      ├── library verifies { order_id, payment_hash } selects a committed attempt
      ├── OpenReceive verifies the receive wallet (batched list_transactions)
      └── settled → write-once settlement transaction → onPaid for the first settled attempt
```

## Host integration

Mounted browser routes receive one `host` object. In the default `db` mode the host supplies
only:

| Option           | Host responsibility                                        |
| ---------------- | ---------------------------------------------------------- |
| `db`             | Handle to the existing database holding `openreceive_payments` |
| `loadOrder`      | Load the host order (or `null` → 404)                      |
| `amountForOrder` | Authoritative `{ sats }` or `{ currency, value }` price    |
| `onPaid`         | In-transaction fulfillment for the first settled attempt   |

Attempt selection, per-order commit locking, the status state machine, write-once settlement,
and reconciliation transitions are library-owned. `authorize` stays separate on the adapter:
OpenReceive does not inspect the host session; it passes the Web-standard `Request`, requested
action, and order ID. Knowing an order ID is not authentication.

`onPaid({ orderId, paymentHash, paidAt, details?, query })` runs inside the settlement
transaction; `query` runs statements (`?` placeholders) in that same transaction for the order
update or an outbox insert. A duplicate sibling settlement is recorded with
`status_reason = 'duplicate_settlement'` and never fulfills again.

The advanced form replaces `db` with `payments: OpenReceivePaymentRepository`
(`listForOrder`, `listReconcilableAttempts`, `commitAttempt`, `recordReconciliation`,
`recordSettlement`, plus `claimReconcileGate` unless the host passes
`opportunisticReconcile: false`); the host then owns locking and the reconciliation
transitions, while write-once settlement stays library-owned — `recordSettlement` is the
claim, and repository-mode `onPaid` (context: `OpenReceiveSettlementEvent` — `paymentHash`,
`paidAt`, `details?`; no `orderId` or transactional `query`) fires only when it is won. If
`commitAttempt` refuses, OpenReceive returns
`409` and withholds the new payer instructions (infrastructure failure: retryable `503`).

See [Payment storage](../guides/storage.md), [Node ORM recipes](../guides/node-orms.md), and
[Authorization](../guides/authorization.md).

## Settlement and reconciliation

Opportunistic reconcile is the default: every mounted payment route runs one gated
`reconcileOpenReceivePayments` pass when attempts are pending, serialized across instances by
the durable `openreceive_meta` gate (unauthenticated `GET /rates` never triggers it). `maybeReconcileOpenReceivePayments({ service, host })`
exposes the same gated pass for host-owned routes and middleware; the optional
`startOpenReceiveNotificationWorker` runs listening plus the periodic pass in one separate
process. Each pass loads only `pending` attempts and issues one batched `list_transactions`
scan (never one lookup per invoice), so the window stays roughly the active invoice window and
no durable cursor exists. Delivery is at-least-once; the settlement transaction makes replays
harmless. Final settlement always requires `settled_at` or wallet state `settled` — never a
preimage. A notification carrying that signal for a known pending attempt settles it directly
through the write-once path (no redundant scan for that invoice); a notification without it, or
for an unknown hash, only wakes a bounded scan.

Terminal transitions (`expired`, `failed`, `attention` plus `status_reason`) require a
successful wallet scan; closure of an unpaid attempt additionally requires the scan to be at or
after `expires_at + OPENRECEIVE_ATTEMPT_EXPIRY_GRACE_SECONDS` (900). Vectors:
`spec/test-vectors/attempt-reconciliation.json`. Stop the notifications worker (if you run
one) before `service.close()` on shutdown.

## Retries, concurrency, and expired invoices

- If the order has no live attempt for the requested rail/asset, OpenReceive creates one and
  commits it before responding.
- Retries reuse a live attempt that still has more than the reuse buffer (60 s) of life; a
  near-expiry same-rail attempt is superseded (`status_reason = 'superseded'`); it stays
  `pending` so a late payment to it still reconciles, and closes only on a wallet scan.
- Concurrent creates serialize per order inside the library repository; the loser receives
  `409` and no invoice.
- A payer can hold one live Lightning attempt and one live swap attempt per asset to switch
  methods; the first wallet settlement fulfills.
- Status polling never creates a new invoice. When all attempts are terminal, a create request
  appends another row. Historical hashes are kept so a late settlement updates the exact
  attempt originally exposed.

## Direct server-side checkout

For a server-rendered flow that does not use mounted browser routes, call the service directly
and commit through the host's library-owned repository before display:

```ts
const checkout = await service.createCheckout({
  orderId: order.id,
  amount: {
    currency: order.currency,
    value: order.total.toString(),
  },
});

await host.payments.commitAttempt({
  orderId: order.id,
  paymentHash: checkout.paymentHash,
  checkout,
});

return checkout;
```

For retry recovery, return the selected attempt's stored `checkout` snapshot
(`host.payments.listForOrder`). Full custom-controller patterns are in
[Custom Controller Integration](custom-controller-integration.md).

## Mounted routes

Default prefix is `/openreceive`. The route set is defined normatively in
[`spec/openapi/openreceive-http.v1.yaml`](../../spec/openapi/openreceive-http.v1.yaml);
the generated route, body, and error tables are in the
[API reference](../guides/api-reference.md#framework-adapters), and the route
list is in [Shipped routes](shipped-routes.md). Do not recreate these routes in
the application.
