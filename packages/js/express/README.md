# @openreceive/express

Express adapter for `@openreceive/http`.

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

app.use(openReceiveExpress({ service, authorize, host }));
```

Settlement piggybacks on the mounted routes by default through the durable
`openreceive_meta` gate (`opportunisticReconcile` disables or tunes it);
`startOpenReceiveNotificationWorker` is the optional worker process.

`onPaid` also receives `query`, which runs inside the settlement transaction —
use it for transactional outbox rows or to make the order update atomic with
the payment record. Plain ORM calls are fine: delivery is at-least-once and
retried until `onPaid` succeeds, so make it idempotent.

The library owns the `openreceive_payments` rows in the host's existing
database: commit locking, write-once settlement, and the reconciliation state
machine. It stores multiple attempts per order and commits one live attempt per
rail before payer instructions are returned. `swapData` stays server-only.
OpenReceive never requires a separate database or Redis.
