# Custom controller integration

Most applications should mount the shipped HTTP handler. Use a custom controller only when the
host needs to own the complete route surface or creates checkouts directly from server code.
OpenReceive service methods do not authenticate callers and never read a host session or order.

## Service surface

| Method | Responsibility |
| --- | --- |
| `createCheckout({ orderId, amount })` | Normalize the host price and mint a wallet invoice. |
| `recoverCheckout({ orderId, paymentHash })` | Reconstruct a still-live checkout for host-row retry reuse. |
| `checkPayment({ paymentHash })` | Verify one payment against wallet authority. |
| `reconcilePayments({ paymentHashes })` | Verify the host's unresolved hashes. |
| `watchPayments({ onPaid })` | Scan and deliver verified settlements at least once. |
| `quoteSwap`, `createSwap`, `getSwap`, `refundSwap` | Create, inspect, and refund host-persisted provider workflows. |
| `listRates`, `quoteRates` | Resolve exact fiat quotes. |

There is no order read, checkout history, migration, sweep cursor, or OpenReceive persistence API.

## Safe checkout route

The host row is the idempotency guard. A controller must reuse a live recorded hash, and must
commit a new hash before sending its BOLT11 to the payer.

```ts
app.post("/checkout", async (request, response) => {
  const order = await orders.authorizedForCheckout(request.user, request.body.order_id);

  if (order.paid_at) {
    response.status(409).json({ message: "Order is already paid." });
    return;
  }

  if (order.payment_hash) {
    const existing = await openreceive.recoverCheckout({
      orderId: order.id,
      paymentHash: order.payment_hash,
    });
    if (existing) {
      response.json(existing);
      return;
    }
  }

  const checkout = await openreceive.createCheckout({
    orderId: order.id,
    amount: { currency: "USD", value: order.price_usd },
  });

  const committed = await orders.setPaymentHashIfEmpty(order.id, checkout.paymentHash);
  if (!committed) {
    // Never expose the losing invoice from a concurrent create.
    response.status(409).json({ message: "Checkout changed; retry." });
    return;
  }

  response.status(201).json(checkout);
});
```

`setPaymentHashIfEmpty` must be a transaction or compare-and-set on the host order. If the host
write fails, withhold the invoice. If the recorded invoice is no longer live, the host decides
when and how its row may be replaced.

## Settlement callback

```ts
const openreceive = await createOpenReceive({
  onPaid: async ({ paymentHash, paidAt }) => {
    await orders.setPaidAtOnce(paymentHash, paidAt);
  },
});
```

Delivery is at least once. `setPaidAtOnce` must match the host order by payment hash, update only
when `paid_at IS NULL`, and make fulfillment idempotent. Notifications are wake-up hints; wallet
lookup or scanning remains settlement authority.

## Custom swap routes

The host price is still authoritative. `createSwap` returns a payment hash, server-only
`swapData`, and public deposit instructions. Store the hash and data atomically before returning
any deposit address or amount. Subsequent status calls use the host-loaded data:

```ts
const current = await openreceive.getSwap({
  orderId: order.id,
  paymentHash: order.payment_hash,
  swapData: order.swap_data,
});
```

`refundSwap({ orderId, paymentHash, swapData, refundAddress })` refreshes the provider ledger before acting. Keep
`swap_data` server-only and exclude it from logs and serializers.

For normative HTTP shapes, use the
[OpenAPI contract](../../spec/openapi/openreceive-http.v1.yaml) and
[Shipped Routes](shipped-routes.md).
