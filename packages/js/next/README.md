# @openreceive/next

Next App Router adapter for the storage-free HTTP handler.

```ts
export const { GET, POST } = openReceiveNextHandlers({
  service,
  authorize,
  resolveCheckout: ({ orderId }) => orders.checkoutStateFor(orderId),
  onCheckoutCreated: ({ orderId, paymentHash }) => orders.commitHash(orderId, paymentHash),
});
```

Return `{ amount?, paymentHash?, swapData? }` from the host row and commit new hashes/data with
a compare-and-set before the public response is exposed. `swapData` stays server-only.
