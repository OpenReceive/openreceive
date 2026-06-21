# What Is OpenReceive

OpenReceive adds uncensorable, global, permissionless inbound payments to any
website or app using open-source, verifiable technology that cannot be shut down.

OpenReceive is not a bank, exchange, payment processor, wallet backend,
custodian, broker, or money transmitter. It does not hold funds, exchange
assets, route money, or operate customer accounts.

OpenReceive's front end checkout helpers give purchasers friendly
route guidance so they can start from a credit card, bank account, Bitcoin
wallet, stablecoin balance, exchange, onramp, or swap service and complete an
instant payment on your website or app.

OpenReceive does three narrow things:

1. Creates one BOLT11 invoice through your app's server-side NWC wallet
   connection.
2. Lets the frontend show QR, copy, open-wallet, countdown, and friendly route
   guidance for that invoice.
3. Lets the backend verify settlement before an app-owned settlement action.

Provider routes are payer-side suggestions. A wallet, exchange, swap service,
fiat onramp, card, bank account, Bitcoin wallet, or stablecoin balance may be
the purchaser's starting point, but reaching the one Lightning invoice happens
through third-party services outside OpenReceive.

## Runtime Model

There is no required OpenReceive daemon. Framework adapters run inside your
app's normal server and job system, and backend packages provide two
long-running pieces:

- a settlement polling runner for restart recovery, final expiry lookup, and
  post-expiry grace verification
- a payment notification listener that keeps the wallet subscription open and
  wakes backend lookup when notifications arrive

In production, deploy your normal web process plus one OpenReceive backend
worker process:

```text
web                 your usual app command
openreceive-worker  openreceive worker
```

The worker starts polling and notification listening together. It uses the same
server-only config as your app, but it runs as its own backend process instead
of inside an HTTP request handler.

Local invoice expiry is not a settlement decision. If the server is down while
an invoice expires, the poll process recovers that invoice after restart
and asks the wallet before OpenReceive closes it as expired.

OpenReceive packages provide the invoice persistence schema for your existing
app database. Run the package migration or install generator, then attach
app-owned hooks such as `onInvoiceSettlement`. Your app keeps its own orders,
carts, users, and fulfillment tables; OpenReceive handles the invoice and
idempotency rows it needs.

- Express routes in an Express app.
- Rails controllers, models, and workers in a Rails app.
- FastAPI routes and workers in a Python app.
- Equivalent native integrations in later ecosystems.

The browser or mobile app receives only display-safe invoice data. NWC secrets,
invoice creation, settlement lookup, polling, notification handling, and
app-owned settlement actions stay server-side.
