# @openreceive/next

Next App Router adapter for the host-owned payment HTTP handler.

```ts
const host = createOpenReceiveHost({
  loadOrder: (orderId) => orders.find(orderId),
  amountForOrder: (order) => order.amount,
  payments,
  onPaid,
});

export const { GET, POST } = openReceiveNextHandlers({
  service,
  authorize,
  host,
});
```

Use `createOpenReceiveHost` with the host's ORM repository. It selects
the exact attempt for reads and appends attempts under an order lock before the
public response. `swapData` stays server-only.
