# Node And Express Quickstart

This quickstart shows the v0.1 server shape: an Express app creates one
Lightning invoice through a server-side NWC connection, exposes display-safe
invoice data to the browser, and verifies settlement on the backend.

OpenReceive does not require an external daemon. The routes mount inside your
web process, and the server package provides two backend runners you run as
separate worker processes:

- a settlement polling runner that recovers open invoices on boot
- a payment notification listener that keeps the NWC subscription open when
  the wallet supports it

## Install

```sh
npm install @openreceive/node @openreceive/express @openreceive/browser @getalby/sdk express pg qrcode
```

Postgres apps need `pg`. SQLite apps can omit `pg` and run on a Node runtime
with `node:sqlite` support.

See [Supported Databases](16-supported-databases.md) for the small supported
matrix. MongoDB, MySQL, and arbitrary user-designed invoice tables are not
supported until OpenReceive ships a store, migration path, and conformance
coverage for them.

## Configure

```sh
OPENRECEIVE_NWC=nostr+walletconnect://...
OPENRECEIVE_WALLET_PROFILE=rizful
DATABASE_URL=postgres://...
```

Commit `.env.example`, not real secrets.

Generate the server-only OpenReceive config and worker entrypoint stubs:

```sh
npx openreceive init
```

This creates `openreceive.config.mjs`, `server/openreceive-routes.mjs`, and
poll/listen worker scripts. Keep the config module server-only; it imports the
NWC connection and durable invoice store.

## Migrate

Run the package-owned OpenReceive invoice schema in your app database. For
Postgres:

```sh
npx openreceive migrate --postgres "$DATABASE_URL"
npx openreceive doctor --postgres "$DATABASE_URL" --config ./openreceive.config.mjs
```

For local or small-app SQLite:

```sh
npx openreceive migrate --sqlite ./storage/openreceive.sqlite3
npx openreceive doctor --sqlite ./storage/openreceive.sqlite3 --config ./openreceive.config.mjs
```

The SQL is still exported for custom migration systems, but app developers
should not hand-design OpenReceive invoice tables.
Without `--config`, doctor checks only database connectivity, required
columns/indexes, and the package-owned OpenReceive migration version. With
`--config`, it also checks server route wiring, durable-store production guards,
NWC preflight, and poll/listen readiness. A config with no store or
`InMemoryInvoiceStore` fails doctor; use the package-owned Postgres or SQLite
store before running production routes or workers.

```ts
import {
  OPENRECEIVE_POSTGRES_MIGRATION_SQL,
  OPENRECEIVE_SQLITE_MIGRATION_SQL
} from "@openreceive/node";
```

## Server

For a new Express app, mount the generated route module:

```ts
import express from "express";
import { mountOpenReceiveRoutes } from "./server/openreceive-routes.mjs";

const app = express();
app.use(express.json());

mountOpenReceiveRoutes(app);

app.listen(3000);
```

Apps with custom auth, CSRF, CORS, logging, or a Postgres store can export their
own `openreceive` object and still use the same package route mount:

```ts
import express from "express";
import pg from "pg";
import {
  createAlbyNwcReceiveClient,
  createOpenReceivePostgresInvoiceStore
} from "@openreceive/node";
import {
  InMemoryInvoiceEventBus,
  mountOpenReceiveExpressRoutes
} from "@openreceive/express";

const app = express();
app.use(express.json());

const wallet = createAlbyNwcReceiveClient({
  connectionString: process.env.OPENRECEIVE_NWC
});
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
});
const store = createOpenReceivePostgresInvoiceStore({
  client: pool
});

await wallet.preflight();

const openreceive = {
  client: wallet,
  store,
  eventBus: new InMemoryInvoiceEventBus(),
  merchantScope: () => "demo:hello-fruit",
  auth: {
    create: (req) => Boolean(req.user),
    read: (req, invoice) => ownsInvoice(req, invoice),
    lookup: (req, invoice) => ownsInvoice(req, invoice),
    events: (req, invoice) => ownsInvoice(req, invoice)
  },
  csrf: {
    verify: (req) => verifyCsrf(req)
  },
  cors: {
    allowed_origins: ["https://example.com"],
    credentials: true
  },
  logger: (entry) => {
    console[entry.level]("[openreceive]", entry);
  }
};

mountOpenReceiveExpressRoutes(app, openreceive);

app.listen(3000);
```

SQLite apps use the same storage contract through the package-owned SQLite
store. Wrap the SQLite driver with `createOpenReceiveSqliteQueryClient()` and
pass it to `createOpenReceiveSqliteInvoiceStore()`.

## Poll Process

The generated `openreceive.config.mjs` exports an `openreceive` object. You can
also point `--config` at any server-only module that exports `openreceive`, a
default config object, or `createOpenReceiveConfig()`. Run the package-owned
worker command as a separate backend process or worker role, not as a thread
inside the web process:

```sh
npx openreceive poll --config ./openreceive.config.mjs
```

Cron-style deployments can run one recovery pass and exit:

```sh
npx openreceive poll --config ./openreceive.config.mjs --once
```

Custom worker scripts can still call the Express runner directly:

```ts
import {
  startOpenReceiveExpressSettlementPollingRunner
} from "@openreceive/express";
import { openreceive } from "./openreceive-config";

startOpenReceiveExpressSettlementPollingRunner(openreceive);
```

## Listen Process

Run this as a second separate backend process when the configured NWC client
supports `payment_received` notifications:

```sh
npx openreceive listen --config ./openreceive.config.mjs
```

Deployment checks can verify listener startup without staying attached:

```sh
npx openreceive listen --config ./openreceive.config.mjs --ready-only
```

Custom worker scripts can call the Express listener directly:

```ts
import {
  startOpenReceiveExpressPaymentNotificationRunner
} from "@openreceive/express";
import { openreceive } from "./openreceive-config";

await startOpenReceiveExpressPaymentNotificationRunner(openreceive);
await new Promise(() => {});
```

If notifications are unavailable, skip the listen process. The poll process
remains the settlement authority.

`InMemoryInvoiceStore` is for demos and tests only. Production Node apps should
use the package-owned durable OpenReceive store backed by the app database so
the poll process can recover non-terminal invoices after restart. Do not invent
your own invoice table.

Use `settlementAction` for the app-owned business effect after OpenReceive
proves settlement by backend lookup.

For a local demo only, `unsafeAllowUnauthenticatedDemoMode: true` can be used
while building the UI. Do not use it in production.

## Server Logs

The Express adapter accepts an optional `logger(entry)` hook. It emits
redacted state transitions such as `invoice.create.requested`,
`invoice.created`, `invoice.verifying`, `invoice.settled`, and
`invoice.events.opened`.

Log entries include invoice ids, payment hashes, amounts, and state names. They
do not include request bodies, NWC connection strings, signed event URL tokens,
authorization headers, cookies, or idempotency keys.

## Create An Invoice

```sh
curl -X POST http://localhost:3000/openreceive/v1/invoices \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: fruit-demo-user-123-order-456' \
  -d @examples/hello-fruit/shared/test-data/create-invoice.amount-msats.json
```

The response contains the BOLT11 invoice, `payment_hash`, timestamps, and
checkout URLs. It does not contain the NWC connection string.

## Browser Helpers

```ts
import {
  copyInvoice,
  createQrSvg,
  openWallet
} from "@openreceive/browser";

const svg = await createQrSvg(invoice.invoice);
await copyInvoice({ invoice: invoice.invoice });
openWallet({ invoice: invoice.invoice });
```

The browser helper uses `lightning:<invoice>` for QR and open-wallet payloads.
The QR helper uses an opaque white background, black foreground, and a
four-module quiet zone.

## Settlement

Your backend runners call `lookup_invoice` and treat the invoice as settled
only when the wallet returns `settled_at` or `state == "settled"`. A preimage
alone is not enough.

Merchant settlement actions should happen in backend code after that lookup
result, not in browser state.
