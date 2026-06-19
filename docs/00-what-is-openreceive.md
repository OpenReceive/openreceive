# What Is OpenReceive

OpenReceive adds Bitcoin Lightning receive payments to an app with a small
backend integration and a frontend checkout.

It does three narrow things:

1. Creates one BOLT11 invoice through the merchant's own server-side NWC wallet
   connection.
2. Lets the frontend show QR, copy, open-wallet, countdown, and route
   suggestion UI for that invoice.
3. Lets the backend verify settlement before fulfillment.

OpenReceive is not a bank, exchange, payment processor, wallet backend,
custodian, broker, or money transmitter. It does not hold funds, exchange
assets, route money, or operate customer accounts.

Provider routes are payer-side suggestions. A wallet, exchange, swap service,
or fiat onramp may be able to pay the one Lightning invoice, but that happens
outside OpenReceive.

## Runtime Model

There is no required OpenReceive daemon. Framework adapters run inside the
merchant's normal app and job system:

- Express routes in an Express app.
- Rails controllers, models, and workers in a Rails app.
- FastAPI routes and workers in a Python app.
- Equivalent native integrations in later ecosystems.

The browser or mobile app receives only display-safe invoice data. NWC secrets,
invoice creation, settlement lookup, polling, notification handling, and
fulfillment stay server-side.
