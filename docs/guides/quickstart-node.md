# Node quickstart

Configure a receive-only NWC connection and `OPENRECEIVE_TOKEN_KEYS=k1:<32-byte-key>`.

```ts
const service = await createOpenReceive({
  nwc: process.env.OPENRECEIVE_NWC,
  onPaid: ({ paymentHash, paidAt }) => orders.markPaidOnce(paymentHash, paidAt),
});
```

For server-rendered/direct flows, call `createCheckout({ orderId, amount })`, store its
`paymentHash`, then return it. For a browser checkout, create the host order first and mount:

```ts
app.use(openReceiveExpress({
  service,
  authorize: createDefaultAuthorize(),
  resolveCheckoutAmount: async ({ orderId }) => {
    const order = await orders.find(orderId);
    if (!order) throw hostError("Order not found.", 404, "NOT_FOUND");
    return {
      amount: { currency: order.currency, value: order.total.toString() },
      ...(order.paymentHash ? { paymentHash: order.paymentHash } : {}),
      ...(order.swapRecoveryToken ? { swapRecoveryToken: order.swapRecoveryToken } : {}),
    };
  },
  onCheckoutCreated: ({ orderId, paymentHash, swapRecoveryToken }) =>
    orders.commitPaymentAttempt(orderId, paymentHash, swapRecoveryToken),
}));
```

The frontend calls its own order-create route and renders `<Checkout orderId={order.id} />`.
OpenReceive posts only the order ID to `/openreceive/checkouts`; the server resolves the price.
Returning the host row's live `paymentHash` makes retries reconstruct that checkout instead of
minting another. `commitPaymentAttempt` must be an atomic compare-and-set.

Run `openreceive doctor` to verify wallet capabilities and `openreceive generate-token-key` to
create a token key. There is no migrate command.
