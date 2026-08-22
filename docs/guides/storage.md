# Payment storage

The ownership rule, verbatim from the normative
[HTTP contract](../../spec/openapi/openreceive-http.v1.yaml):

> Your application owns orders; the library owns the `openreceive_payments`
> rows (they live in your database).

This page is the canonical home of that statement — other docs link here
instead of restating it. OpenReceive never owns orders, users, prices, or
fulfillment, and never requires a separate database, Redis, or migration
runner. You run the `openreceive_payments` migration through your own workflow
and pass a database handle (`db`); the library owns the schema, per-order
commit locking, write-once settlement, and the reconciliation state machine.

## Schema

The canonical DDL lives in `@openreceive/core` —
`openReceivePaymentsDdlStatements` in `payments-ddl.ts` is the single source
of truth every rendering derives from:
`openReceivePaymentsSchemaSql(dialect)` (`"postgres"` or `"sqlite"`) renders
it as one executable script, and `npx openreceive scaffold payments` emits it
as a migration for your ORM. There is nothing to adjust — `order_id` is always
`TEXT` and carries no foreign key, because OpenReceive never reads, writes,
locks, or joins your order table. Every column must stay:

```text
openreceive_payments
  id             primary key
  order_id       required, indexed, opaque TEXT (no FK); many attempts per order
  payment_hash   required, unique, 64 lowercase hex (CHECK)
  status         required, default 'pending' (CHECK: the five statuses below)
  status_reason  nullable operator-facing detail
  paid_at        nullable, write-once
  expires_at     required
  created_at     required exact wallet invoice creation time
  updated_at     required
  inserted_at    required local insertion time, stamped once and never changed
  checkout_data  required safe JSON snapshot (BOLT11, amount, timestamps)
  swap_data      nullable JSON/text, server-only provider credential
  client_ip      nullable client IP captured at invoice creation
```

Two CHECK constraints back the app-level invariants at the database: `status`
must be one of the five statuses in the table below, and `payment_hash` must be
64 lowercase hexadecimal characters. There is deliberately **no** unique index
for "one live attempt per rail": liveness is time-dependent (a superseded or
just-expired attempt stays `pending` until a wallet scan closes it), and any
uniqueness over pending rows would reject legitimate reminting. The repository
enforces that rule inside the per-order commit lock instead. Generated index
names are truncated with a short digest when a custom table name would push
them past Postgres's 63-byte identifier limit.

The same DDL (and every migration path) also creates `openreceive_meta`
(`key` primary key, `value`, `rev`) next to `openreceive_payments`. Its
`transaction_scan_gate` row is the durable claim — an optimistic CAS shared by
every instance on the database — that serializes opportunistic reconcile
passes so rapid calls collapse to one wallet scan per interval, and its
`schema_version` row records which generation of this schema is installed.

### Schema version

`openReceivePaymentsSchemaSql` seeds `openreceive_meta.schema_version` with
`OPENRECEIVE_PAYMENTS_SCHEMA_VERSION` (currently `1`). The upgrade rule:

- **Stored version newer than the library's** — the repository refuses to run.
  Upgrade `@openreceive/http` (or the gem) before pointing it at that database;
  an older library cannot be trusted with rows a newer one wrote.
- **Stored version older** — the library migrates forward once a migration for
  that step exists. Until then version `1` is the only generation.
- **No `schema_version` row** — treated as unversioned, not as a failure. A
  migration emitted by an ORM template that cannot seed rows (Prisma's schema
  file, for instance) simply has no marker; nothing refuses to run.

### SQLite and Postgres notes

On SQLite the library sets `PRAGMA busy_timeout` on the handle it is given, so a
commit that races your application's own write waits for the write lock
instead of failing immediately with `SQLITE_BUSY`.

SQL you write in `onPaid` — through the settlement transaction's `query` — is
passed to your driver **verbatim**. Write the placeholders your database uses:
`?` on SQLite, `$1`-style on Postgres. Nothing rewrites your statement, so a
`?` inside a string literal, a comment, or a Postgres JSON operator
(`metadata ? 'field'`) is safe. The library writes its own statements in each
dialect's native style for the same reason.

`checkout_data` stores the complete payer response (BOLT11, amount, timestamps),
so when a payer reloads the checkout page, OpenReceive re-serves the same
invoice from this row instead of calling the wallet again — the page keeps
working even while the wallet is unreachable. Never serialize or log
`swap_data`.

`client_ip` is the adapter-attributed payer IP at invoice creation (null when
none was attributable). It backs the opt-in per-IP
[rate limiting](rate-limiting.md) — the limiter is a count over these rows
through the `(client_ip, inserted_at)` index, so no separate counter table
exists. Treat it as request-log metadata under your privacy policy.

## Attempt state machine

| Status      | Meaning                                     | Possible `status_reason`                           |
| ----------- | ------------------------------------------- | -------------------------------------------------- |
| `pending`   | Live or awaiting reconciliation             | `superseded` on an attempt replaced while still payable |
| `settled`   | Wallet-verified payment; never overwritten  | `duplicate_settlement` on a sibling second payment |
| `expired`   | Closed unpaid                               | `wallet_reported_expired`, `not_found_after_expiry`, `no_finality_after_expiry` |
| `failed`    | Wallet reported the invoice failed          | `wallet_reported_failed`                           |
| `attention` | Wallet still explicitly reports an in-flight state after expiry — review in the wallet | `unsettled_after_expiry` |

`attention` rows need an operator: check the invoice in the wallet — if the payment actually
settled, the next reconciliation pass (or a `payments/check`) records it; if it is stuck,
resolve it wallet-side. Shops should surface `attention` internally (alerting/admin), never to
the payer — the payer-facing UI keeps showing the ordinary pending/expired states.

Only `pending` attempts are reconciled, so the wallet scan window stays bounded
at roughly the active invoice window. A superseded attempt keeps `pending`
status (with `status_reason = 'superseded'`) rather than closing immediately:
its invoice stays payable until it expires wallet-side, so it must stay in the
scan set or a payer who pays it would deliver funds nothing could ever match.
It is no longer offered to a payer, and it closes like any other pending row. Closing an unpaid attempt requires a
successful wallet scan at or after `expires_at` plus the 900-second grace
(`OPENRECEIVE_ATTEMPT_EXPIRY_GRACE_SECONDS` — an exported constant, not an
environment variable) — a local clock alone never closes
a row, because a payment could have settled while the application was offline.
A scan that ran out of pages before reaching an attempt is not a successful
scan for that attempt: the pass reports nothing for it and the row stays
pending, so a truncated walk can never close a paid invoice.
Vectors: [`spec/test-vectors/attempt-reconciliation.json`](../../spec/test-vectors/attempt-reconciliation.json).

Each pass reconciles the oldest `OPENRECEIVE_RECONCILE_BATCH_SIZE` (200 — an
exported constant in both implementations; Ruby:
`OpenReceive::Server::RECONCILE_BATCH_SIZE`)
pending attempts. The rows nearest their closure deadline are always covered,
and a backlog drains over successive passes instead of loading every pending
row into one wallet scan window.

Settlement is write-once per attempt. `onPaid` runs inside the settlement
transaction only for the order's first settled attempt; a genuine second
settlement of a sibling attempt is recorded (`duplicate_settlement`) and never
fulfills again.

## Live attempts

An order has one live payment session; within it, at most one live attempt per
rail/asset, so a payer can switch between Lightning and swap assets. A retry or
concurrent create serializes per order inside the library. Your application
never sees this vocabulary — an order is simply unpaid or paid.

One row holds at most one provider swap order. A swap retry creates another row
with a fresh invoice hash; status, refresh, and refund requests keep operating
on the existing row.

## Escape hatch

If your persistence cannot be reached through a supported `db` handle,
implement the `OpenReceivePaymentRepository` interface yourself and pass it as
`payments` instead of `db`. You then own the storage primitives — commit
locking (`commitAttempt`), the first-settlement claim (`recordSettlement`),
reconciliation transitions (`recordReconciliation`), and `claimReconcileGate`,
the `openreceive_meta` equivalent for your store; construction throws unless
you implement the gate or pass `opportunisticReconcile: false`.

The state machine itself stays library-owned in this mode too. The settlement
hook is `onPaid` in this mode as well, but it receives the raw
`OpenReceiveSettlementEvent` (`paymentHash`, `paidAt`, `details?`) instead of
db mode's `OpenReceiveOrderSettlement` — no `orderId` and no transactional
`query`, because your repository owns that mapping. OpenReceive calls
`recordSettlement` for every observed settlement and runs your `onPaid` only
when that call reports it won the order's first-settlement
claim, so a redelivered settlement event fulfills exactly once. Return `true`
only when the attempt was still unsettled and no sibling attempt on the order
had settled; record a genuine second payment and return `false`, and never
overwrite a settled attempt. This is the advanced path, not the quickstart —
see [Node ORM recipes](node-orms.md) and the interface docs in
`@openreceive/http`.

Rails applications get the migration from `bin/rails generate openreceive:install`;
the `OpenReceivePayment` model is engine-owned. See the
[Rails quickstart](quickstart-rails.md).
