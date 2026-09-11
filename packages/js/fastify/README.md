# @openreceive/fastify

Accept Bitcoin Lightning payments in your Fastify app, directly into a
wallet you control. Register the plugin with your database handle and three
hooks for authorization, order amounts, and fulfillment. OpenReceive manages
payment attempts and reconciliation in your existing database while your app
keeps its orders and customers.

OpenReceive supports optional swaps from **USDT, USDC, SOL, and ETH** through
a configured swap provider. The provider converts the payment to **BTC over
Lightning**, which settles into the merchant's connected wallet. Available
assets and networks depend on the provider; swaps are optional.

## Install

This package is ESM-only and requires Node >= 22.

```sh
npm install @openreceive/fastify
```

Start with the [integration quickstart](https://github.com/openreceive/openreceive/blob/master/docs/guides/quickstart-fastify.md)
and the [payment storage guide](https://github.com/openreceive/openreceive/blob/master/docs/guides/storage.md).

## Connect your application

The all-in-one form is the happy path: register the plugin with the order
hooks and a database handle, and it builds the service and host itself.

The example below assumes your app has a database handle (`db`) and an order
lookup (`orders`). Apply the payment-table migration from the quickstart first.

```ts
import { openReceiveFastify } from "@openreceive/fastify";

await fastify.register(openReceiveFastify, {
  wallet: { nwc: process.env.NWC_URI! }, // receive-only; your app refuses to start otherwise
  storage: {
    db, // pg Pool/Client, node:sqlite, better-sqlite3, or a custom adapter
    onPaid: async ({ reference, query }) => {
      // Host SQL reaches your driver VERBATIM: `?` on sqlite as shown,
      // `$1` on postgres. Nothing rewrites placeholders.
      await query("UPDATE orders SET state = 'paid' WHERE id = ?", [reference]);
    },
  },
  amountFor: (reference) => orders.find(reference)?.amount ?? null, // null → 404
  authorize: ({ resource }) => orders.viewerOwns(resource.reference),
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
`openreceive_payments` rows — per-reference commit locking, write-once settlement,
and the reconciliation state machine.

Composing needs `@openreceive/http` and `@openreceive/node` as direct
dependencies of your app — they are transitive dependencies of this adapter, so
under pnpm or any strict-resolution install, importing them without adding them
fails:

```sh
npm install @openreceive/http @openreceive/node
```

```ts
import { openReceiveFastify } from "@openreceive/fastify";
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

await fastify.register(openReceiveFastify, { service, authorize, host, prefix: "/openreceive" });
```

This package re-exports only the curated `@openreceive/http` surface: the
handler/stack factories, the error surface, the notification worker, the
options/context/hook types, and the generated `Wire*` wire body
types. Host-integration internals — `createHost`, the SQL payment
repository, the reconcile gate, the rate-limit helpers — live only in
`@openreceive/http`; import them from there when composing your own host
(`npm run check:public-api` pins both surfaces).

## Guides

- [Frontend checkout](https://github.com/openreceive/openreceive/blob/master/docs/guides/frontend-checkout.md)
- [Optional swaps](https://github.com/openreceive/openreceive/blob/master/docs/guides/automated-swaps.md)
- [Host testing](https://github.com/openreceive/openreceive/blob/master/docs/guides/host-testing.md)
