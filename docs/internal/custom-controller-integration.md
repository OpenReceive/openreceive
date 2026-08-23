> **Advanced escape hatch.** Almost every host should use `<Checkout>` / the custom
> element instead. This integration bypasses the shipped controller wiring and takes on its
> lifecycle responsibilities (re-keying polling after swaps, backoff, settled-state handling).

# Custom controller integration

Most applications should mount the shipped HTTP handler. Use a custom controller only when the
host needs to own the complete route surface or creates checkouts directly from server code.
OpenReceive service methods do not authenticate callers and never read a host session or order.

## Service surface

| Method | Responsibility |
| --- | --- |
| `prepareCheckout({ amount })` | Resolve the charged msats (and any fiat quote) without minting. |
| `createCheckout({ orderId, amount })` | Normalize the host price and mint a wallet invoice. |
| `checkPayment({ paymentHash, createdAt })` | Verify one payment with bounded wallet-history scans. |
| `reconcilePayments({ attempts })` | Batch-verify the host's unresolved hashes and creation times. |
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
  const order = await orders.authorizedForCheckout(request.user, request.body.order_id);

  const existing = await payments.listForOrder(order.id);
  const live = existing.find((row) => row.status === "pending" && row.expiresAt > now());
  if (live) {
    response.json(live.checkout);
    return;
  }

  const checkout = await openreceive.createCheckout({
    orderId: order.id,
    amount: { currency: "USD", value: order.price_usd },
  });

  try {
    await payments.commitAttempt({ orderId: order.id, paymentHash: checkout.paymentHash, checkout });
  } catch {
    // Already paid, or a concurrent create won. Never expose the losing invoice.
    response.status(409).json({ message: "Checkout changed; retry." });
    return;
  }

  response.status(201).json(checkout);
});
```

`commitAttempt` serializes per order inside the library, rejects a paid order or a reusable
live same-rail attempt, and supersedes a near-expiry one. If it throws, withhold the invoice.
Terminal attempts remain as history and a later request may append a new row.

## Settlement callback

```ts
const checked = await openreceive.checkPayment({
  paymentHash: payment.payment_hash,
  createdAt: payment.created_at,
});
if (checked.status === "settled" && checked.paidAt !== undefined) {
  await payments.markPaidOnce(
    { paymentHash: checked.paymentHash, paidAt: checked.paidAt },
    async ({ orderId, query }) => {
      await query("UPDATE orders SET state = 'paid' WHERE id = ?", [orderId]);
    },
  );
}
```

Delivery is at least once. `markPaidOnce` sets the attempt settled exactly once and runs the
fulfill hook inside the same transaction, only for the order's first settled attempt; a sibling
second settlement is recorded with `status_reason = 'duplicate_settlement'` without fulfilling.
A notification that carries a finality signal (`settled_at` or wallet state `settled`) for a
known pending attempt settles it directly through `markPaidOnce`; without that signal, or for an
unknown hash, it is only a wake-up hint and `list_transactions` scanning decides. The finality
rule is the same either way — never a preimage alone.

## Custom swap routes

The host price is still authoritative. `createSwap` returns a payment hash, server-only
`swapData`, and public deposit instructions. Store the hash and data atomically before returning
any deposit address or amount. Subsequent status calls use the host-loaded data:

```ts
const current = await openreceive.getSwap({
  orderId: order.id,
  paymentHash: payment.payment_hash,
  swapData: payment.swap_data,
});
```

`refundSwap({ orderId, paymentHash, swapData, refundAddress })` refreshes the provider ledger before acting. Keep
`swap_data` server-only and exclude it from logs and serializers.

For normative HTTP shapes, use the
[OpenAPI contract](../../spec/openapi/openreceive-http.v1.yaml) and
[Shipped Routes](shipped-routes.md).
