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
3. Lets the backend verify payment before app-owned fulfillment runs.

Provider routes are payer-side suggestions. A wallet, exchange, swap service,
fiat onramp, card, bank account, Bitcoin wallet, or stablecoin balance may be
the purchaser's starting point, but reaching the one Lightning invoice happens
through third-party services outside OpenReceive.

## Runtime Model

OpenReceive runs inside your normal web process. Your checkout route creates an
app order, calls OpenReceive server-side to create the invoice, and returns
display-safe invoice data to the browser. The browser checkout watches your
backend order-status route to learn when an invoice settles. For extra recovery,
you can optionally call `openreceive poll --once` on a server-side schedule.

```text
web process        handles /create_order and /order_status
browser checkout   watches app order status
optional scheduler runs openreceive poll --once
```

The OpenReceive store is the only thing coordinating payment state across
processes.

Local invoice expiry is not a payment decision. If your server is down while an
invoice expires, optional recovery can still verify recent invoices before they
are closed as expired.

OpenReceive packages provide their own invoice storage, selected with
`OPENRECEIVE_STORE`. Your app keeps its own orders, carts, users, and
fulfillment tables.

- Express routes in an Express app.
- Rails controllers in a Rails app.
- FastAPI routes in a Python app.
- Equivalent native integrations in later ecosystems.

The browser or mobile app receives only display-safe invoice data. The
receive-only NWC code, invoice creation, payment verification, recovery polling,
and `onPaid` fulfillment stay server-side.
