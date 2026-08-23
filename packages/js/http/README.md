# @openreceive/http

Framework-neutral receive-checkout handler. Its normal form requires `service`,
`authorize`, and the `host` integration. Create bodies never accept payer
amounts; the host's `amountFor` hook is the only price authority, and the
commit hook appends a payment-attempt row before the invoice is returned.

This package is ESM-only and requires Node >= 22.

`createHost({ db, amountFor, onPaid })` builds that
host integration on the library-owned payment repository inside the host
application's existing database (pg, node:sqlite, better-sqlite3, or a custom
adapter). The library owns attempt selection, per-reference commit locking,
write-once settlement with first-attempt-only fulfillment, and the
`pending → settled | expired | failed | attention` reconciliation state
machine (`attention` reads as `pending` on the wire; operators see it only in
`openreceive_payments.status`). `onPaid` is the settlement hook in both modes: with `db` it receives
`PaymentSettlement` (`reference` plus a `query` that runs inside the
settlement transaction); with a custom repository it receives the raw
`SettlementEvent` (`paymentHash`, `paidAt`, `details`). Settlement
piggybacks on mounted routes by default through the durable `openreceive_meta`
gate (`opportunisticReconcile: false` disables, `{ minIntervalSeconds }`
tunes); `startNotificationWorker` is the optional
listen-plus-reconcile worker process. A custom `PaymentRepository`
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

- Handler and stack: `createHttpHandler`, `createStack`,
  their options types, and `mapHostRouteError` / `HttpError` /
  `HostError`.
- Host integration: `createHost`, the SQL repository
  (`createSqlPayments`, `paymentsSchemaSql`), the
  `PaymentRepository` contract types, and the settlement hook
  contexts above.
- Reconciliation: `maybeReconcilePayments` (the durable gate pass),
  `reconcileHostPayments`, `startReconciler`, and the shared
  constants (`OPENRECEIVE_ATTEMPT_EXPIRY_GRACE_SECONDS`,
  `OPENRECEIVE_RECONCILE_BATCH_SIZE`, scan bounds).
- Rate limiting: `createIpRateLimit`, `resolveClientIp`, and
  `IpRateLimitConfig` behind the handler's `rateLimiting` /
  `rateLimitHook` options.
- Generated wire types: the snake_case `Wire*` request/response body
  types (`WireCheckout`, `WireCreateCheckoutRequest`,
  `WirePaymentCheck`, `WireError`, …), generated from the
  OpenAPI contract. The adapters re-export these too.

See the root README, the storage guide, and the OpenAPI contract.
