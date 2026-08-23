# @openreceive/express

Express adapter for `@openreceive/http`.

This package is ESM-only and requires Node >= 22.

The all-in-one form is the happy path: pass the host hooks and a database
handle, and the middleware builds the service and host itself.

```ts
import { openReceiveExpress } from "@openreceive/express";

app.use(
  openReceiveExpress({
    wallet: { nwc: process.env.NWC_URI! }, // receive-only; your app refuses to start otherwise
    storage: {
      db, // pg Pool/Client, node:sqlite, better-sqlite3, or a custom adapter
      onPaid: async ({ reference, query }) => {
        await query("UPDATE orders SET state = 'paid' WHERE id = ?", [reference]);
      },
    },
    amountFor: (reference) => orders.find(reference)?.amount ?? null, // null → 404
    authorize: ({ native, resource }) =>
      orders.ownedBy(
        (native as { session?: { userId?: string } }).session?.userId,
        resource.reference,
      ),
  }),
);
```

`onPaid` runs inside the settlement transaction, only for the order's first
settled attempt. Do the order update (or insert an outbox row) through the
supplied `query`: a plain ORM call commits on its own connection, so it would
survive a rolled-back settlement — settlement side effects belong on `query`.
Delivery is at-least-once and retried until `onPaid` succeeds, so make it
idempotent, and keep it to database writes: an email or webhook sent from here
survives a rolled-back settlement and goes out again on the retry. Flag the
order and drain it from your own worker after commit.

Settlement piggybacks on the mounted routes by default through the durable
`openreceive_meta` gate (`opportunisticReconcile` disables or tunes it);
`startNotificationWorker` is the optional worker process. Behind a
reverse proxy, the `trustProxyIpHeader` option attributes `rateLimiting`
client IPs from a proxy-set header instead of `req.ip`.

## Advanced: composed form

Construct the pieces yourself (shared service, custom repository, tests) and
pass them in. `createHost` is the persistence step: it owns the
`openreceive_payments` rows in the host's existing database — per-reference commit
locking, write-once settlement, and the reconciliation state machine — and the
mounted routes commit one live attempt per rail before payer instructions are
returned. `swapData` stays server-only. OpenReceive never requires a separate
database or Redis.

```ts
import { openReceiveExpress } from "@openreceive/express";
import { createHost } from "@openreceive/http";
import { createOpenReceive } from "@openreceive/node";

const service = await createOpenReceive(); // reads NWC_URI

const host = createHost({
  db,
  amountFor: (reference) => orders.find(reference)?.amount ?? null, // null → 404
  onPaid: async ({ reference, query }) => {
    await query("UPDATE orders SET state = 'paid' WHERE id = ?", [reference]);
  },
});

app.use(openReceiveExpress({ service, authorize, host }));
```

This package re-exports only the curated `@openreceive/http` surface: the
handler/stack factories, the error surface, the notification worker, the
options/context/hook types, and the generated `Wire*` wire body
types. Host-integration internals — `createHost`, the SQL payment
repository, the reconcile gate, the rate-limit helpers — live only in
`@openreceive/http`; import them from there when composing your own host
(`npm run check:public-api` pins both surfaces).
