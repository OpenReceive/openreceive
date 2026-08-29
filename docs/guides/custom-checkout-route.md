# Writing your own checkout route

> **Advanced escape hatch.** Almost every application should mount the shipped
> adapter instead: it gives you the routes, and the shipped checkout components
> (`<Checkout>` / the custom element) work against them with no glue. Bypassing
> it also means taking over the controller's lifecycle responsibilities
> (re-keying polling after swaps, backoff, settled-state handling).

Write your own route only when you need a flow the shipped routes do not
offer, or when you create checkouts directly from server code. You then drive
`service` and `host` yourself, and the order of operations is the whole
contract:

1. **Check access yourself.** Nothing calls your `authorize` here, so without a
   check anyone holding an order id can mint invoices against it.
2. **Mint** with [`service.createCheckout`](api-reference.md#servicecreatecheckout).
3. **Commit the attempt row** — `host.onCheckoutCreated`, or the repository's
   `commitAttempt` as in the route below.
4. **Only then return the invoice.** Skip the commit and a payer can pay an
   invoice your database has no row for.

OpenReceive service methods do not authenticate callers and never read your
session or order.

## Service surface

| Method | Responsibility |
| --- | --- |
| `prepareCheckout({ amount })` | Resolve the charged msats (and any fiat quote) without minting. |
| `createCheckout({ reference, amount })` | Normalize the host price and mint a wallet invoice. |
| `reconcilePayments({ attempts })` | Verify one or many known invoices with bounded wallet-history scans. |
| `listSwapOptions({ amountMsats })` | List configured swap pay-in methods for an invoice amount. |
| `quoteSwap`, `createSwap`, `getSwap`, `refundSwap` | Create, inspect, and refund host-persisted provider workflows. |
| `listRates` | Read the cached BTC/fiat rates. (`quoteRates` also exists but is JS-internal plumbing — no HTTP route, no Ruby counterpart.) |

There is no order read, checkout history route, migration runner, or durable workflow cursor.
Attempt persistence lives in `@openreceive/http` (`createSqlPayments`), not in the
service.

## Safe checkout route

Even a custom controller should use the library-owned repository
(`createSqlPayments(db)`) so commit locking, the status state machine, and
write-once settlement stay library code. The row commits before the BOLT11 reaches the payer.

```ts
import { createSqlPayments } from "@openreceive/http";

const payments = createSqlPayments(db);

app.post("/checkout", async (request, response) => {
  const order = await orders.authorizedForCheckout(request.user, request.body.reference);

  const existing = await payments.listForReference(order.id);
  const live = existing.find((row) => row.status === "pending" && row.expiresAt > now());
  if (live) {
    response.json(live.checkout);
    return;
  }

  const checkout = await openreceive.createCheckout({
    reference: order.id,
    amount: { currency: "USD", value: order.price_usd },
  });

  try {
    await payments.commitAttempt({ reference: order.id, paymentHash: checkout.paymentHash, checkout });
  } catch {
    // Already paid, or a concurrent create won. Never expose the losing invoice.
    response.status(409).json({ message: "Checkout changed; retry." });
    return;
  }

  response.status(201).json(checkout);
});
```

`commitAttempt` serializes per reference inside the library, rejects a paid order or a reusable
live same-rail attempt, and supersedes a near-expiry one. If it throws, withhold the invoice.
Terminal attempts remain as history and a later request may append a new row.

## Settlement callback

```ts
const [checked] = await openreceive.reconcilePayments({
  attempts: [{ paymentHash: payment.payment_hash, createdAt: payment.created_at }],
});
if (checked?.status === "settled" && checked.paidAt !== undefined) {
  await payments.markPaidOnce(
    { paymentHash: checked.paymentHash, paidAt: checked.paidAt },
    async ({ reference, query }) => {
      await query("UPDATE orders SET state = 'paid' WHERE id = ?", [reference]);
    },
  );
}
```

Delivery is at least once. `markPaidOnce` settles the attempt exactly once
and runs the fulfill hook in the same transaction, only for the first
settled attempt on a reference. A second payment to a sibling invoice is
recorded and never fulfills again. A preimage alone is never settlement.

## Custom swap routes

The host price is still authoritative. `createSwap` returns a payment hash, server-only
`swapData`, and public deposit instructions. Store the hash and data atomically before returning
any deposit address or amount. Subsequent status calls use the host-loaded data:

```ts
const current = await openreceive.getSwap({
  reference: order.id,
  paymentHash: payment.payment_hash,
  swapData: payment.swap_data,
});
```

`refundSwap({ reference, paymentHash, swapData, refundAddress })` refreshes the provider ledger before acting. Keep
`swap_data` server-only and exclude it from logs and serializers.

For normative HTTP shapes, use the
[OpenAPI contract](../../spec/openapi/openreceive-http.v1.yaml) and
[Shipped Routes](../internal/shipped-routes.md).
