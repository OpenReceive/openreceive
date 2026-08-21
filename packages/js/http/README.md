# @openreceive/http

Framework-neutral receive-checkout handler. Its normal form requires `service`,
`authorize`, and the `host` integration. Create bodies never accept payer
amounts; the host resolver reads the order price, and the commit hook appends a
payment-attempt row before the invoice is returned.

This package is ESM-only and requires Node >= 22.

`createOpenReceiveHost({ db, loadOrder, amountForOrder, onPaid })` builds that
host integration on the library-owned payment repository inside the host
application's existing database (pg, node:sqlite, better-sqlite3, or a custom
adapter). The library owns attempt selection, per-order commit locking,
write-once settlement with first-attempt-only fulfillment, and the
`pending → settled | expired | failed | attention` reconciliation state
machine. Settlement piggybacks on mounted routes by default through the
durable `openreceive_meta` gate (`opportunisticReconcile: false` disables,
`{ minIntervalSeconds }` tunes); `startOpenReceiveNotificationWorker` is the
optional listen-plus-reconcile worker process. A custom
`OpenReceivePaymentRepository` via the `payments` option is
the advanced escape hatch.

It reuses one live attempt per rail, permits new attempts after expiry, and
verifies the `payment_hash` selector belongs to the authorized order. Committed
retries use the stored safe checkout snapshot. `swapData` is never serialized
into an HTTP response. OpenReceive never requires a separate database or Redis.
See the root README, the storage guide, and the OpenAPI contract.
