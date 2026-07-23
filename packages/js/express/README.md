# @openreceive/express

Express adapter for `@openreceive/http`.

```ts
app.use(openReceiveExpress({
  service,
  authorize,
  resolveCheckoutAmount: ({ orderId }) => orders.checkoutStateFor(orderId),
  onCheckoutCreated: ({ orderId, paymentHash }) => orders.commitHash(orderId, paymentHash),
}));
```

OpenReceive has no storage or migrations.
`checkoutStateFor` returns `{ amount, paymentHash?, swapRecoveryToken? }`, so a retry reuses the
host row's live checkout. The commit must be an atomic compare-and-set.
