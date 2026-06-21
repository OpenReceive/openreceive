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
npm install @openreceive/node @openreceive/express @openreceive/browser @getalby/sdk express qrcode
```

## Configure

```sh
OPENRECEIVE_NWC=nostr+walletconnect://...
OPENRECEIVE_WALLET_PROFILE=rizful
```

Commit `.env.example`, not real secrets.

## Server

```ts
import express from "express";
import {
  InMemoryInvoiceStore
} from "@openreceive/core";
import {
  createAlbyNwcReceiveClient
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

await wallet.preflight();

const openreceive = {
  client: wallet,
  store: new InMemoryInvoiceStore(),
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

## Poll Process

Put the `openreceive` object in a shared server-only module, then import it from
the web, poll, and listen entrypoints.

Run this as a separate backend process or worker role, not as a thread inside
the web process:

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

`InMemoryInvoiceStore` is for demos and tests. Production apps should provide a
package-owned durable OpenReceive store backed by the app database so the poll
process can recover non-terminal invoices after restart. Do not ask each app to
invent its own invoice table; the Node package should ship migrations or ORM
templates for the OpenReceive invoice/idempotency rows.

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
