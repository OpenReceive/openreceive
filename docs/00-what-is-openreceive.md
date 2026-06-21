# What Is OpenReceive

OpenReceive adds Bitcoin Lightning receive payments to an app with a small
backend integration and a frontend checkout.

It does three narrow things:

1. Creates one BOLT11 invoice through the merchant's own server-side NWC wallet
   connection.
2. Lets the frontend show QR, copy, open-wallet, countdown, and route
   suggestion UI for that invoice.
3. Lets the backend verify settlement before an app-owned settlement action.

OpenReceive is not a bank, exchange, payment processor, wallet backend,
custodian, broker, or money transmitter. It does not hold funds, exchange
assets, route money, or operate customer accounts.

Provider routes are payer-side suggestions. A wallet, exchange, swap service,
or fiat onramp may be able to pay the one Lightning invoice, but that happens
outside OpenReceive.

## Runtime Model

There is no required OpenReceive daemon. Framework adapters run inside the
merchant's normal app and job system, and backend packages provide two
long-running pieces:

- a settlement polling runner for restart recovery, final expiry lookup, and
  post-expiry grace verification
- a payment notification listener that keeps the wallet subscription open and
  wakes backend lookup when notifications arrive

In production, run those as your web process plus one OpenReceive backend
worker process. The worker starts polling and notification listening together.
They are not browser code and should not be modeled as threads inside the web
request path.

Local invoice expiry is not a settlement decision. If the server is down while
an invoice expires, the poll process must recover that invoice after restart
and ask the wallet before OpenReceive closes it as expired.

OpenReceive packages should also provide the invoice persistence schema for the
host app database. Developers should run the package migration or install
generator, then attach app-owned hooks such as `onInvoiceSettlement`; they
should not design OpenReceive invoice/idempotency tables by hand.

- Express routes in an Express app.
- Rails controllers, models, and workers in a Rails app.
- FastAPI routes and workers in a Python app.
- Equivalent native integrations in later ecosystems.

The browser or mobile app receives only display-safe invoice data. NWC secrets,
invoice creation, settlement lookup, polling, notification handling, and
app-owned settlement actions stay server-side.
