# @openreceive/fastify

Fastify adapter for `@openreceive/http`.

This package is ESM-only and requires Node >= 22.

The all-in-one form is the happy path: register the plugin with the order
hooks and a database handle, and it builds the service and host itself.

```ts
import { openReceiveFastify } from "@openreceive/fastify";

await fastify.register(openReceiveFastify, {
  wallet: { nwc: process.env.NWC_URI! }, // receive-only; boot fails closed otherwise
  storage: {
    db, // pg Pool/Client, node:sqlite, better-sqlite3, or a custom adapter
    onPaid: async ({ orderId, query }) => {
      await query("UPDATE orders SET state = 'paid' WHERE id = ?", [orderId]);
    },
  },
  loadOrder: (orderId) => orders.find(orderId),
  amountForOrder: (order) => order.amount,
  authorize: ({ resource }) => orders.viewerOwns(resource.orderId),
  prefix: "/openreceive",
});
```

`onPaid` runs inside the settlement transaction, only for the order's first
settled attempt. Do the order update (or insert an outbox row) through the
supplied `query`: a plain ORM call commits on its own connection, so it would
survive a rolled-back settlement — settlement side effects belong on `query`.
Delivery is at-least-once and retried until `onPaid` succeeds, so make it
idempotent, and keep it to database writes: an email or webhook sent from here
survives a rolled-back settlement and goes out again on the retry. Flag the
order and drain it from your own worker after commit.

The library-owned repository commits a payment-attempt row in the host's
existing database before payer instructions are returned, and settlement
piggybacks on the mounted routes by default through the durable
`openreceive_meta` gate (`opportunisticReconcile` disables or tunes it);
`startNotificationWorker` is the optional worker process. Behind a
reverse proxy, the `trustProxyIpHeader` option attributes `rateLimiting`
client IPs from a proxy-set header. OpenReceive never requires a separate
database or Redis.

## Advanced: composed form

Construct the pieces yourself (shared service, custom repository, tests) and
pass them in. `createHost` is the persistence step: it owns the
`openreceive_payments` rows — per-order commit locking, write-once settlement,
and the reconciliation state machine.

```ts
import { openReceiveFastify } from "@openreceive/fastify";
import { createHost } from "@openreceive/http";
import { createOpenReceive } from "@openreceive/node";

const service = await createOpenReceive(); // reads NWC_URI

const host = createHost({
  db,
  loadOrder: (orderId) => orders.find(orderId),
  amountForOrder: (order) => order.amount,
  onPaid: async ({ orderId, query }) => {
    await query("UPDATE orders SET state = 'paid' WHERE id = ?", [orderId]);
  },
});

await fastify.register(openReceiveFastify, { service, authorize, host, prefix: "/openreceive" });
```

This package re-exports only the curated `@openreceive/http` surface: the
handler/stack factories, the error surface, the notification worker, the
options/context/hook types, and the generated `Wire*` wire body
types. Host-integration internals — `createHost`, the SQL payment
repository, the reconcile gate, the rate-limit helpers — live only in
`@openreceive/http`; import them from there when composing your own host
(`npm run check:public-api` pins both surfaces).
