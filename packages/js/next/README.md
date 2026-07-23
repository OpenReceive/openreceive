# @openreceive/next

Next App Router adapter for the storage-free HTTP handler.

```ts
export const { GET, POST } = openReceiveNextHandlers({
  service,
  authorize,
  resolveCheckoutAmount: ({ orderId }) => orders.checkoutStateFor(orderId),
  onCheckoutCreated: ({ orderId, paymentHash }) => orders.commitHash(orderId, paymentHash),
});
```

Return `{ amount, paymentHash?, swapRecoveryToken? }` from the host row and commit new hashes
with a compare-and-set before the response is exposed.
