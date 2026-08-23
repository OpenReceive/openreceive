# @openreceive/next

Next App Router adapter for the OpenReceive payment HTTP handler.

This package is ESM-only and requires Node >= 22.

The all-in-one form is the happy path: pass the order hooks and a database
handle, and the handlers build the service and host themselves.

```ts
import { openReceiveNextHandlers } from "@openreceive/next";

export const { GET, POST } = openReceiveNextHandlers({
  nwc: process.env.NWC_URI!, // receive-only; boot fails closed otherwise
  db, // pg Pool/Client, node:sqlite, better-sqlite3, or a custom adapter
  loadOrder: (orderId) => orders.find(orderId),
  amountForOrder: (order) => order.amount,
  onPaid: async ({ orderId, query }) => {
    await query("UPDATE orders SET state = 'paid' WHERE id = ?", [orderId]);
  },
  authorize: ({ resource }) => orders.viewerOwns(resource.orderId),
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

The library owns the `openreceive_payments` rows in the host's existing
database. It selects the exact attempt for reads and appends attempts under a
per-order lock before the public response. Settlement piggybacks on the
mounted routes by default through the durable `openreceive_meta` gate —
serverless-safe, no background process (`opportunisticReconcile` disables or
tunes it); `startOpenReceiveNotificationWorker` is the optional worker.
`swapData` stays server-only. Behind a reverse proxy, the `trustProxyIpHeader`
option attributes `rateLimiting` client IPs from a proxy-set header.

## Advanced: composed form

Construct the pieces yourself (shared service, custom repository, tests) and
pass them in. `createOpenReceiveHost` is the persistence step: it owns the
`openreceive_payments` rows — per-order commit locking, write-once settlement,
and the reconciliation state machine.

```ts
import { createOpenReceiveHost } from "@openreceive/http";
import { openReceiveNextHandlers } from "@openreceive/next";
import { createOpenReceive } from "@openreceive/node";

const service = await createOpenReceive(); // reads NWC_URI

const host = createOpenReceiveHost({
  db,
  loadOrder: (orderId) => orders.find(orderId),
  amountForOrder: (order) => order.amount,
  onPaid: async ({ orderId, query }) => {
    await query("UPDATE orders SET state = 'paid' WHERE id = ?", [orderId]);
  },
});

export const { GET, POST } = openReceiveNextHandlers({ service, authorize, host });
```

This package re-exports only the curated `@openreceive/http` surface: the
handler/stack factories, the error surface, the notification worker, the
options/context/hook types, and the generated `OpenReceiveWire*` wire body
types. Host-integration internals — `createOpenReceiveHost`, the SQL payment
repository, the reconcile gate, the rate-limit helpers — live only in
`@openreceive/http`; import them from there when composing your own host
(`npm run check:public-api` pins both surfaces).
