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
machine (`attention` reads as `pending` on the wire; operators see it only in
`openreceive_payments.status`). `onPaid` is the settlement hook in both modes: with `db` it receives
`OpenReceiveOrderSettlement` (`orderId` plus a `query` that runs inside the
settlement transaction); with a custom repository it receives the raw
`OpenReceiveSettlementEvent` (`paymentHash`, `paidAt`, `details`). Settlement
piggybacks on mounted routes by default through the durable `openreceive_meta`
gate (`opportunisticReconcile: false` disables, `{ minIntervalSeconds }`
tunes); `startOpenReceiveNotificationWorker` is the optional
listen-plus-reconcile worker process. A custom `OpenReceivePaymentRepository`
via the `payments` option is the advanced escape hatch.

It reuses one live attempt per rail, permits new attempts after expiry, and
verifies the `payment_hash` selector belongs to the authorized order. Committed
retries use the stored safe checkout snapshot. `swapData` is never serialized
into an HTTP response. OpenReceive never requires a separate database or Redis.

This is the home of the full host-integration surface. The framework adapters
(`@openreceive/express`, `@openreceive/fastify`, `@openreceive/next`) re-export
only a curated slice — the handler/stack factories, error surface, notification
worker, and their options/context/hook types — so anything deeper imports from
here (`npm run check:public-api` pins both surfaces):

- Handler and stack: `createOpenReceiveHttpHandler`, `createOpenReceiveStack`,
  their options types, and `mapHostRouteError` / `OpenReceiveHttpError` /
  `OpenReceiveHostError`.
- Host integration: `createOpenReceiveHost`, the SQL repository
  (`createOpenReceiveSqlPayments`, `openReceivePaymentsSchemaSql`), the
  `OpenReceivePaymentRepository` contract types, and the settlement hook
  contexts above.
- Reconciliation: `maybeReconcileOpenReceivePayments` (the durable gate pass),
  `reconcileOpenReceivePayments`, `startOpenReceiveReconciler`, and the shared
  constants (`OPENRECEIVE_ATTEMPT_EXPIRY_GRACE_SECONDS`,
  `OPENRECEIVE_RECONCILE_BATCH_SIZE`, scan bounds).
- Rate limiting: `createOpenReceiveIpRateLimit`, `openReceiveClientIp`, and
  `OpenReceiveIpRateLimitConfig` behind the handler's `rateLimiting` /
  `rateLimitHook` options.
- Generated wire types: the snake_case `OpenReceiveWire*` request/response body
  types (`OpenReceiveWireCheckout`, `OpenReceiveWireCreateCheckoutRequest`,
  `OpenReceiveWirePaymentCheck`, `OpenReceiveWireError`, …), generated from the
  OpenAPI contract. The adapters re-export these too.

See the root README, the storage guide, and the OpenAPI contract.
