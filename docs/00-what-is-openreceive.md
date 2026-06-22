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
app's normal server. Backend packages provide route-driven lookup recovery and
an optional one-shot poll command for platform schedulers:

```text
web                 your usual app command, mounts /openreceive/v1
optional scheduler  POST /openreceive/v1/poll or openreceive poll --once
```

There is no notification listener, webhook bridge, SSE bus, or in-memory
coordination state. The durable OpenReceive store coordinates lookup gates,
recovery sweeps, and settlement-action leases across web processes.

Local invoice expiry is not a settlement decision. If the server is down while
an invoice expires, the poll process recovers that invoice after restart
and asks the wallet before OpenReceive closes it as expired.

OpenReceive packages provide their own invoice KV persistence, selected with
`OPENRECEIVE_STORE`. Your app keeps its own orders, carts, users, and
fulfillment tables; OpenReceive handles the invoice, idempotency, lookup-gate,
and settlement-action state it needs.

- Express routes in an Express app.
- Rails controllers in a Rails app.
- FastAPI routes in a Python app.
- Equivalent native integrations in later ecosystems.

The browser or mobile app receives only display-safe invoice data. NWC secrets,
invoice creation, settlement lookup, recovery polling, and app-owned settlement
actions stay server-side.
