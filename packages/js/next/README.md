# @openreceive/next

Next App Router adapter for the host-owned payment HTTP handler.

```ts
const paymentHooks = createOpenReceivePaymentHooks({
  loadOrder: (orderId) => orders.find(orderId),
  amountForOrder: (order) => order.amount,
  payments,
});

export const { GET, POST } = openReceiveNextHandlers({
  service,
  authorize,
  resolveCheckout: paymentHooks.resolveCheckout,
  onCheckoutCreated: paymentHooks.onCheckoutCreated,
});
```

Use `createOpenReceivePaymentHooks` with the host's ORM repository. It selects
the exact attempt for reads and appends attempts under an order lock before the
public response. `swapData` stays server-only.
