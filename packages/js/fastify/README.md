# @openreceive/fastify

Fastify adapter for `@openreceive/http`. Register it with `service`, host
`authorize`, and the `host` integration returned by
`createOpenReceiveHost({ db, loadOrder, amountForOrder, onPaid })`:

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

await fastify.register(openReceiveFastify, { service, authorize, host, prefix: "/openreceive" });
```

`onPaid` also receives `query`, which runs inside the settlement transaction —
use it for transactional outbox rows or to make the order update atomic with
the payment record. Plain ORM calls are fine: delivery is at-least-once and
retried until `onPaid` succeeds, so make it idempotent. The
library-owned repository commits a payment-attempt row in the host's existing
database before payer instructions are returned, and settlement piggybacks on
the mounted routes by default through the durable `openreceive_meta` gate
(`opportunisticReconcile` disables or tunes it);
`startOpenReceiveNotificationWorker` is the optional worker process.
OpenReceive never requires a separate database or Redis.
