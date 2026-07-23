# @openreceive/express

Express adapter for `@openreceive/http`.

```ts
app.use(openReceiveExpress({
  service,
  authorize,
  resolveCheckout: ({ orderId }) => orders.checkoutStateFor(orderId),
  onCheckoutCreated: ({ orderId, paymentHash }) => orders.commitHash(orderId, paymentHash),
}));
```

OpenReceive has no storage or migrations.
`checkoutStateFor` returns `{ amount?, paymentHash?, swapData? }`, so retries and reads use the
host row. `swapData` stays server-only. The commit must be an atomic compare-and-set.
