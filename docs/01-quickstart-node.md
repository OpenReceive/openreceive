# Node And Express Quickstart

This quickstart shows the v0.1 server shape: an Express app creates one
Lightning invoice through a server-side NWC connection, exposes display-safe
invoice data to the browser, and verifies settlement on the backend.

OpenReceive does not run a daemon. The routes mount inside your app.

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
  mountOpenReceiveExpressRoutes
} from "@openreceive/express";

const app = express();
app.use(express.json());

const wallet = createAlbyNwcReceiveClient({
  connectionString: process.env.OPENRECEIVE_NWC
});

await wallet.preflight();

mountOpenReceiveExpressRoutes(app, {
  client: wallet,
  store: new InMemoryInvoiceStore(),
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
});

app.listen(3000);
```

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

Your backend calls `lookup_invoice` and treats the invoice as settled only when
the wallet returns `settled_at` or `state == "settled"`. A preimage alone is
not enough.

Merchant settlement actions should happen in backend code after that lookup
result, not in browser state.
