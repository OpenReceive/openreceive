# What Is OpenReceive

OpenReceive adds uncensorable, global, permissionless inbound payments to any
website or app using only open-source technology.

OpenReceive is not a bank, exchange, payment processor, wallet backend,
custodian, broker, or money transmitter. It does not hold funds, exchange
assets, route money, or operate customer accounts.

OpenReceive's front end checkout helpers give purchasers friendly
route guidance so they can start from a credit card, bank account, Bitcoin
wallet, stablecoin balance, exchange, onramp, or swap service and complete an
instant payment on the merchant's website.

OpenReceive does three narrow things:

1. Creates one BOLT11 invoice through the merchant's own server-side NWC wallet
   connection.
2. Lets the frontend show QR, copy, open-wallet, countdown, and friendly route
   guidance for that invoice.
3. Lets the backend verify settlement before an app-owned settlement action.

Provider routes are payer-side suggestions. A wallet, exchange, swap service,
fiat onramp, card, bank account, Bitcoin wallet, or stablecoin balance may be
the purchaser's starting point, but reaching the one Lightning invoice happens
through third-party services outside OpenReceive.

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
They are not browser code. Do not model them as threads inside the web request
path.

Local invoice expiry is not a settlement decision. If the server is down while
an invoice expires, the poll process recovers that invoice after restart
and asks the wallet before OpenReceive closes it as expired.

OpenReceive packages provide the invoice persistence schema for the host app
database. Run the package migration or install generator, then attach
app-owned hooks such as `onInvoiceSettlement`. Do not design OpenReceive
invoice/idempotency tables by hand.

- Express routes in an Express app.
- Rails controllers, models, and workers in a Rails app.
- FastAPI routes and workers in a Python app.
- Equivalent native integrations in later ecosystems.

The browser or mobile app receives only display-safe invoice data. NWC secrets,
invoice creation, settlement lookup, polling, notification handling, and
app-owned settlement actions stay server-side.
