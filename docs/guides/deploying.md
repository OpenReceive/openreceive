# Deploying OpenReceive

OpenReceive has no separate deployment storage service and needs no dedicated
settlement infrastructure. Every web instance needs the same receive-only NWC
configuration and access to your database; everything that must be
durable — attempt rows, the settlement write-once claim, and the scan gate —
lives in that database.

## Multi-instance semantics

The library serializes attempt insertion per reference (Postgres advisory lock or
SQLite immediate transaction), enforces unique `payment_hash`, and makes
settlement write-once inside the database it is handed. Scale web
instances freely: restarts and overlapping passes repeat bounded, idempotent
work, and delivery is at-least-once with the write-once settlement transaction
as the replay guard. Process-local caches (rates, provider weights, the
`payments/check` payment-methods warm cache) are performance controls only —
restarting or splitting instances may cause extra calls, never lost durable
truth.

## The durable scan gate

The default settlement driver is the request path: every mounted OpenReceive
payment route runs one opportunistic reconcile pass when attempts are pending.
Every scan entry point — the request-path pass, the notifications worker's
periodic pass, and a directly driven reconciler — claims the same durable gate
first: the `openreceive_meta` row `transaction_scan_gate` in your
database, claimed by optimistic CAS. The gate serializes wallet scans across
every instance and Puma worker, so rapid calls collapse to one real scan per
interval. The interval floors at 2 seconds and stretches with pending-invoice
age (2 s while any pending invoice is under 2 minutes old, 6 s under
5 minutes, else 12 s).

The gate is the NWC scan budget: open tabs polling `payments/check` share the
one global pass, and when payer A closes the tab, payer B's later call wins
the gate and settles A's invoice. The winner awaits one bounded pass (9 s scan
timeout, capped pages) — serverless-safe, since no timer outlives the
request; a failed or timed-out scan warns and never fails the payer's
request, and the gate's claim stays in place so a broken wallet cannot
stampede. Unauthenticated `GET …/rates` never triggers the pass — crawlers
and health checks cannot consume the scan budget.

Each pass selects only `pending` rows — the oldest
`OPENRECEIVE_RECONCILE_BATCH_SIZE` (200) per pass — so the scan window stays
roughly the active invoice window, the rows nearest their closure deadline
are always covered, and a backlog drains over successive passes. There is no
durable cursor, no OpenReceive-owned sweep database, and no privileged sweep
route. Closing an unpaid attempt requires a successful scan at or after
expiry plus the 900-second grace — never the local clock alone.

## Worker topology

No background process is required. The optional additions:

- **Node** — one `startNotificationWorker({ service, host })`
  process total (not per instance): it listens for NWC-02 `payment_received`
  notifications and runs the periodic safety-net pass in the same process.
- **Rails** — the equivalent single worker is
  `bin/rails openreceive:notifications`. One-shot primitives
  (`OpenReceive.reconcile!`, `OpenReceive::ReconcileJob`,
  `bin/rails openreceive:reconcile`) remain available; nothing needs
  scheduling.

Both workers scan through the same gate and the same write-once settlement
path as the request-path pass, so running one alongside many web instances is
safe.

## When your application boots

Wallet preflight fails closed on a missing or spend-capable NWC connection:
your application does not start with one. On Node the adapters run preflight
lazily (the first request awaits it); use the middleware's `ready` promise in
a deploy health check to surface failures at rollout. The Rails engine builds the wallet client — and runs preflight — eagerly in
production, so a bad `NWC_URI`, a dead relay, or a spend-capable wallet stops
the deploy instead of surfacing as customer-facing 500s on the first checkout.

## Operational monitoring

`attention` rows are the one state that wants an operator: the wallet still
reports an in-flight state long after expiry, or a swap needs review. They
read as `pending` on the wire — payers never see them — so alert on them
internally:

```sql
SELECT reference, payment_hash, status_reason, expires_at
FROM openreceive_payments
WHERE status = 'attention';
```

Check each in the wallet: if the payment actually settled, the next
reconciliation pass (or a `payments/check`) records it; if it is stuck,
resolve it wallet-side. Swap attempts flagged `attention` carry the provider
context in their swap status (`attention_reason`, `deposit_received_amount`,
`emergency_repeat`).

See [Payment storage](storage.md) for the schema and state machine, and
[Rate limiting](rate-limiting.md) for the per-IP cap's proxy configuration.
