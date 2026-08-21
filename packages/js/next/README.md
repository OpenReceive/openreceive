# @openreceive/next

Next App Router adapter for the OpenReceive payment HTTP handler.

This package is ESM-only and requires Node >= 22.

```ts
const host = createOpenReceiveHost({
  db, // pg Pool/Client, node:sqlite, better-sqlite3, or a custom adapter
  loadOrder: (orderId) => orders.find(orderId),
  amountForOrder: (order) => order.amount,
  onPaid: async ({ orderId }) => {
    await prisma.order.update({ where: { id: orderId }, data: { state: "paid" } });
  },
});

export const { GET, POST } = openReceiveNextHandlers({
  service,
  authorize,
  host,
});
```

`onPaid` also receives `query`, which runs inside the settlement transaction —
use it for transactional outbox rows or to make the order update atomic with
the payment record. Plain ORM calls are fine: delivery is at-least-once and
retried until `onPaid` succeeds, so make it idempotent.

The library owns the `openreceive_payments` rows in the host's existing
database. It selects the exact attempt for reads and appends attempts under a
per-order lock before the public response. Settlement piggybacks on the
mounted routes by default through the durable `openreceive_meta` gate —
serverless-safe, no background process (`opportunisticReconcile` disables or
tunes it); `startOpenReceiveNotificationWorker` is the optional worker.
`swapData` stays server-only.
