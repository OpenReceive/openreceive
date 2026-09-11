# @openreceive/next

Add Bitcoin Lightning checkout to your Next.js App Router application and
receive payments directly into a wallet you control. The route handlers
connect your existing database to three application hooks: authorization,
order amounts, and fulfillment. OpenReceive handles payment attempts and
reconciliation on the server.

OpenReceive supports optional swaps from **USDT, USDC, SOL, and ETH** through
a configured swap provider. The provider converts the payment to **BTC over
Lightning**, which settles into the merchant's connected wallet. Available
assets and networks depend on the provider; swaps are optional.

## Install

This package is ESM-only and requires Node >= 22.

```sh
npm install @openreceive/next
```

Start with the [integration quickstart](https://github.com/openreceive/openreceive/blob/master/docs/guides/quickstart-next.md)
and the [payment storage guide](https://github.com/openreceive/openreceive/blob/master/docs/guides/storage.md).

## Connect your application

The all-in-one form is the happy path: pass the host hooks and a database
handle, and the handlers build the service and host themselves.

The example below assumes your app has a database handle (`db`) and an order
lookup (`orders`). Apply the payment-table migration from the quickstart first.

```ts
import { openReceiveNextHandlers } from "@openreceive/next";

export const { GET, POST } = openReceiveNextHandlers({
  wallet: { nwc: process.env.NWC_URI! }, // receive-only; your app refuses to start otherwise
  storage: {
    db, // pg Pool/Client, node:sqlite, better-sqlite3, or a custom adapter
    onPaid: async ({ reference, query }) => {
      await query("UPDATE orders SET state = 'paid' WHERE id = ?", [reference]);
    },
  },
  amountFor: (reference) => orders.find(reference)?.amount ?? null, // null → 404
  authorize: ({ resource }) => orders.viewerOwns(resource.reference),
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
per-reference lock before the public response. Settlement piggybacks on the
mounted routes by default through the durable `openreceive_meta` gate —
serverless-safe, no background process (`opportunisticReconcile` disables or
tunes it); `startNotificationWorker` is the optional worker.
`swapData` stays server-only. Behind a reverse proxy, the `trustProxyIpHeader`
option attributes `rateLimiting` client IPs from a proxy-set header.

## Advanced: composed form

Construct the pieces yourself (shared service, custom repository, tests) and
pass them in. `createHost` is the persistence step: it owns the
`openreceive_payments` rows — per-reference commit locking, write-once settlement,
and the reconciliation state machine.

Add the packages you import directly when composing the integration:

```sh
npm install @openreceive/http @openreceive/node
```

```ts
import { createHost } from "@openreceive/http";
import { openReceiveNextHandlers } from "@openreceive/next";
import { createOpenReceive } from "@openreceive/node";

const service = await createOpenReceive(); // reads NWC_URI

const host = createHost({
  db,
  amountFor: (reference) => orders.find(reference)?.amount ?? null, // null → 404
  onPaid: async ({ reference, query }) => {
    await query("UPDATE orders SET state = 'paid' WHERE id = ?", [reference]);
  },
});

export const { GET, POST } = openReceiveNextHandlers({ service, authorize, host });
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
