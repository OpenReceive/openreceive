# OpenReceive Agent Rules

This is a greenfield project with no compatibility or migration constraint, and no current users. Optimize for a
small, honest API and a good developer experience.

## Non-negotiables

- OpenReceive never owns orders, users, prices, or fulfillment, and never requires a separate
  database, Redis, or migration runner. It MAY own payment-attempt rows (`openreceive_payments`)
  inside the host application's existing database: the host passes its database handle and runs
  the migration through its own workflow; the library owns the schema, locking, settlement
  write-once, and reconciliation state machine. Implementing a custom
  `PaymentRepository` is the documented escape hatch, never the quickstart.
- The host owns orders and prices. Direct server code passes `{ reference, amount }`; mounted
  HTTP handlers resolve the amount from host-owned data and reject payer-supplied amounts.
- One `openreceive_payments` row per attempt is committed before payer instructions are
  exposed. A reference may have multiple historical attempts; `payment_hash` is globally unique,
  settlement is write-once per attempt, and fulfillment runs only for the reference's first settled
  attempt.
- Attempts carry an explicit status (`pending`, `settled`, `expired`, `failed`, `attention`).
  Only `pending` attempts are reconciled; closure of an unpaid attempt requires a successful
  wallet scan at or after expiry plus `OPENRECEIVE_ATTEMPT_EXPIRY_GRACE_SECONDS` (an exported
  constant, 900 seconds — not an environment variable) — a local clock alone never closes a
  row. A settled row is never overwritten.
- Settlement discovery is opportunistic by default: every mounted OpenReceive route first runs
  one reconcile pass through the durable `openreceive_meta` gate (CAS in the host database,
  minimum 2 seconds between real wallet scans, stretched by invoice age), shared by every
  worker/process — the gate IS the NWC scan budget, and `payments/check` serves the requested
  hash from that pass (or the host row on `gate_busy`), never a second per-invoice wallet
  walk. No web process starts a settlement timer; the optional notifications worker
  (NWC-02 listener + periodic pass) is a separate process. A custom repository without
  `claimReconcileGate` must disable `opportunisticReconcile` explicitly — the default
  settlement path never degrades silently, and process-local memory never backs the gate.
- A retry or concurrent create serializes per reference inside the library repository. A reference has
  one live payment session; within it, at most one live attempt per rail/asset so a payer can
  switch methods. The host never sees the live/supersede/conflict vocabulary — it sees an order
  as unpaid or paid. Do not add a separately configured OpenReceive idempotency store.
- Receive-only NWC codes must never reach browser/mobile code, logs, tests, screenshots,
  docs, source maps, or demo assets. Receive APIs never expose send-payment methods. Wallet
  preflight fails closed when the connection advertises spend methods; booting anyway requires
  the explicit `allowSpendCapableWallet` / `OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC` override.
- NWC notifications are authenticated wallet data: a conforming client decrypts them with the
  same key material that authenticates RPC responses. A `payment_received` payload that
  satisfies the settlement rule (`settled_at` or `transaction_state/state == "settled"`; a
  preimage alone is corroborating evidence) settles the matching pending attempt directly,
  with no redundant wallet scan for that invoice. Anything less — a payload without a finality
  signal, or an unknown payment hash — only triggers a bounded reconciliation scan. The
  notifications worker's own periodic pass (plus request-path opportunistic reconcile) remains
  the safety net for notifications missed while offline. Direct settlement
  assumes the NWC client binds notification decryption to the connection's wallet pubkey (the
  bundled SDK does); a custom client that skips author verification must not be granted it.
- Use `amount_msats` for millisatoshi values in public results and exact integer/decimal money
  math. Never use binary floats for fiat math.
- Swap provider credentials live only in the host payment attempt's optional server-only
  `swap_data` field.
  They never appear in browser responses or logs. Provider completion is not wallet
  settlement; refund decisions refresh provider state.
- Do not duplicate provider data, supported currencies, settlement rules, polling cadence, or
  demo product data.
- Schema or route changes update their vectors in the same change. Invoice behavior needs
  host-row retry/concurrency tests; settlement behavior needs replay-safe tests.
- We should not worry about validating the NWC's responses or behavior: a user of OpenReceive implicitly
  trusts their backing NWC service, because they will need to use that NWC service anyway to withdraw any funds.
  OpenReceive users can also build their own fully self-custodial NWC service, or use a fully self-custodial NWC service
  like an Alby Hub instance running on their own hardware.

## Shipped routes and hooks

- `@openreceive/http` adapters and the Rails engine ship the route set in
  `spec/openapi/openreceive-http.v1.yaml`.
- The host keeps authentication. The quickstart host contract is `authorize`, `amountFor`,
  and `onPaid` plus a database handle; the library derives
  `resolveCheckout` / `onCheckoutCreated` and the reconciliation transitions from its own
  repository. The advanced hook surface remains for custom-repository hosts.
- OpenReceive mints no authentication, recovery, or refund tokens. The host authorizes every
  request and verifies the requested `payment_hash` belongs to the reference before resolving
  server-only `swap_data`.
- `onCheckoutCreated` runs before a create response. Failure returns 409 and withholds the
  invoice or swap instructions.

## Testing

Use the smallest relevant test while iterating. `npm test` is the JS suite; the contract and
secret check is:

```sh
npm run check
```

For JS/TS changes, run a focused test first and then at minimum:

```sh
npm run typecheck && npm test
```

For broad route, package, contract, schema, release, or deployment changes, run:

```sh
npm run test:ci
```

Wallet behavior also requires `npm run test:live:nwc`; it must skip clearly when `nwc` is not
configured. Ruby is a second settlement engine and must match the shared money, settlement,
swap-data, and HTTP vectors:

```sh
npm run test:ruby
```

Before declaring work done, report the exact checks run and any intentional skip.

## Display boundary

One bug class, one rule. A value arrives from a server and crosses a parse boundary that bounds
its type but not its range; it then reaches a throwing formatter inside a render path, and the
throw takes the whole panel — frequently the screen the payer reaches after paying. The parse
boundary is right to be permissive (the panel's job is to report what arrived) and the formatter
is right to throw (wire construction and validation share it). The join is what must not exist.

FORMATTERS THROW: `formatMsats` throws `RangeError` on an unusable amount and keeps
throwing on purpose. DISPLAY BOUNDARIES BLANK: `optionalMsatsLabel` and `optionalUnixTimeLabel`
(`packages/js/browser/src/internal/checkout-format.ts`) wrap those formatters and return
`undefined`, so a malformed server value costs one label or one row, never the screen; callers
keep rendering the raw value beside the blanked label so nothing is hidden from whoever debugs it.
The predicates behind them are module-private on purpose — a caller reaching for the predicate is
about to re-implement the boundary.

For a new instance: if the formatter's throw is load-bearing elsewhere, leave it throwing and add
a boundary; if nothing constructs or validates through it, let the formatter degrade (as
`formatUnixTime` does). Express the predicate once, module-private, next to the
formatter. Keep the raw value visible under a relabelled row.

## Private boundary

Do not add private openreceive.org application code, infrastructure inventory, host IPs,
deployment credentials, analytics, landing pages, or business logic to this public repo.
