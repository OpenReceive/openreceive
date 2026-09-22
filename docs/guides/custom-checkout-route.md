# Writing your own checkout route

> **Advanced escape hatch.** Almost every application should mount the shipped
> adapter instead. The adapter gives you the routes, and the shipped checkout
> components (`<Checkout>` / the custom element) work with them without extra
> code. If you bypass it, you also take over the controller's lifecycle work:
> re-keying polling after swaps, backoff, and handling the settled state.

Write your own route only when you need a flow the shipped routes do not offer,
or when you create checkouts directly from server code. You then call
`service` and `host` yourself. The order of the steps is the whole contract:

1. **Check access yourself.** Nothing calls your `authorize` here. Without a
   check, anyone with an order id can create invoices against it.
2. **Create the invoice** with [`service.createCheckout`](api-reference.md#servicecreatecheckout).
3. **Commit the attempt row** with `host.onCheckoutCreated`, or with the
   repository's `commitAttempt` as in the route below.
4. **Only then return the invoice.** If you skip the commit, a payer can pay an
   invoice your database has no row for.

OpenReceive service methods do not authenticate callers. They never read your
session or your order.

## Service surface

| Method | Responsibility |
| --- | --- |
| `prepareCheckout({ amount })` | Work out the msats to charge (and any fiat quote) without creating an invoice. |
| `createCheckout({ reference, amount })` | Normalize the host price and create a wallet invoice. |
| `reconcilePayments({ attempts })` | Check one or many known invoices with bounded wallet-history scans. |
| `listSwapOptions({ amountMsats })` | List the configured swap pay-in methods for an invoice amount. |
| `quoteSwap`, `createSwap`, `getSwap`, `refundSwap` | Create, inspect, and refund provider workflows that the host stores. |
| `listRates` | Read the cached BTC/fiat rates. `quoteRates` also exists, but it is internal JS plumbing with no HTTP route and no Ruby counterpart. |

The service has no order read, checkout history route, migration runner, or
durable workflow cursor. Attempt storage lives in `@openreceive/http`
(`createSqlPayments`), not in the service.

## Safe checkout route

Even a custom controller should use the library's own repository
(`createSqlPayments(db)`). That keeps commit locking, the status state machine,
and write-once settlement in library code. The row is committed before the
BOLT11 reaches the payer.

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

`commitAttempt` handles one request per reference at a time inside the library.
It rejects a paid order, or a live attempt on the same rail that can be reused.
It replaces an attempt that is close to expiry. If it throws, do not return the
invoice. Finished attempts stay as history, and a later request may add a new
row.

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

Delivery is at least once, so the same result may arrive more than once.
`markPaidOnce` settles the attempt exactly once. It runs the fulfill hook in the
same transaction, and only for the first settled attempt on a reference. If the
payer also pays a sibling invoice, that second payment is recorded but never
fulfills the order again. A preimage alone never counts as settlement.

## Custom swap routes

The host price is still the one that counts. `createSwap` returns a payment
hash, server-only `swapData`, and public deposit instructions. Store the hash
and the data together, in one atomic write, before you return any deposit
address or amount. Later status calls use the data the host loads back:

```ts
const current = await openreceive.getSwap({
  reference: order.id,
  paymentHash: payment.payment_hash,
  swapData: payment.swap_data,
});
```

`refundSwap({ reference, paymentHash, swapData, refundAddress })` refreshes the
provider's records before it acts. Keep `swap_data` on the server and exclude it
from logs and serializers.

For the exact HTTP shapes, use the
[OpenAPI contract](../../spec/openapi/openreceive-http.v1.yaml) and
[Shipped Routes](../internal/shipped-routes.md).
