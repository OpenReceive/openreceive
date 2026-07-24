# Custom controller integration

Most applications should mount the shipped HTTP handler. Use a custom controller only when the
host needs to own the complete route surface or creates checkouts directly from server code.
OpenReceive service methods do not authenticate callers and never read a host session or order.

## Service surface

| Method | Responsibility |
| --- | --- |
| `createCheckout({ orderId, amount })` | Normalize the host price and mint a wallet invoice. |
| `checkPayment({ paymentHash, createdAt })` | Verify one payment with bounded wallet-history scans. |
| `reconcilePayments({ attempts })` | Batch-verify the host's unresolved hashes and creation times. |
| `quoteSwap`, `createSwap`, `getSwap`, `refundSwap` | Create, inspect, and refund host-persisted provider workflows. |
| `listRates`, `quoteRates` | Resolve exact fiat quotes. |

There is no order read, checkout history route, migration runner, runtime persistence API, or
durable workflow cursor.

## Safe checkout route

The host order lock is the serialization guard. A controller reuses one live payment row and
commits a new row before sending its BOLT11 to the payer.

```ts
app.post("/checkout", async (request, response) => {
  const order = await orders.authorizedForCheckout(request.user, request.body.order_id);

  if (await payments.anyPaid(order.id)) {
    response.status(409).json({ message: "Order is already paid." });
    return;
  }

  const payment = await payments.findLiveForOrder(order.id);
  if (payment) {
    response.json(payment.checkout_data);
    return;
  }

  const checkout = await openreceive.createCheckout({
    orderId: order.id,
    amount: { currency: "USD", value: order.price_usd },
  });

  try {
    await payments.commitWhileLockingOrder({ order, checkout });
  } catch {
    // Never expose the losing invoice from a concurrent create.
    response.status(409).json({ message: "Checkout changed; retry." });
    return;
  }

  response.status(201).json(checkout);
});
```

`commitWhileLockingOrder` inserts into `openreceive_payments` while holding the host order lock.
If the write fails, withhold the invoice. Expired attempts remain as history and a later request
may append a new row.

## Settlement callback

```ts
const openreceive = await createOpenReceive();

const checked = await openreceive.checkPayment({
  paymentHash: payment.payment_hash,
  createdAt: payment.created_at,
});
if (checked.status === "settled") {
  await payments.markPaidOnceAndFulfillFirst(checked.paymentHash, checked.paidAt);
}
```

Delivery is at least once. The host matches the attempt by payment hash, updates only when its
`paid_at IS NULL`, and fulfills only when no sibling attempt was already paid. Notifications are wake-up hints; wallet
`list_transactions` scanning remains settlement authority.

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
