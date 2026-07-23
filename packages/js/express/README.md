# @openreceive/express

Express adapter for `@openreceive/http`.

```ts
const paymentHooks = createOpenReceivePaymentHooks({
  loadOrder: (orderId) => orders.find(orderId),
  amountForOrder: (order) => order.amount,
  payments,
});

app.use(openReceiveExpress({
  service,
  authorize,
  resolveCheckout: paymentHooks.resolveCheckout,
  onCheckoutCreated: paymentHooks.onCheckoutCreated,
}));
```

The runtime has no storage configuration. The host-owned payment repository
stores multiple attempts per order and locks the order while committing one
live attempt. `swapData` stays server-only.
