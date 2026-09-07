# Payment storage

Your application owns orders. The library owns the `openreceive_payments`
rows, and they live in your database.

OpenReceive never owns orders, users, prices, or fulfillment, and never
requires a separate database, Redis, or migration runner. You run the
migration through your own workflow and pass a database handle (`db`). The
library owns the schema, per-reference locking, write-once settlement, and
the reconciliation state machine.

## Schema

`npx openreceive scaffold payments` (or the Rails install generator) emits
the migration. Keep every column it creates:

```text
openreceive_payments
  id             primary key
  reference      required, indexed; many attempts per reference
  payment_hash   required, unique, 64 lowercase hex
  status         pending | settled | expired | failed | attention
  status_reason  nullable operator-facing detail
  paid_at        nullable, write-once
  expires_at     required
  created_at     required wallet invoice creation time
  updated_at     required
  inserted_at    required, stamped once
  checkout_data  required payer-safe JSON (bolt11, amount, timestamps)
  swap_data      nullable, server-only provider credential
  client_ip      nullable, captured at invoice creation
```

The same migration creates `openreceive_meta` beside it. Leave that table
alone — it is the reconcile gate shared by every instance.

`checkout_data` is how a reload re-serves the same invoice without another
wallet call. Never serialize or log `swap_data`.

SQL you write in `onPaid` is passed to your driver as-is. Use `?` on SQLite
and `$1` on Postgres.

`client_ip` backs the opt-in [rate limiter](rate-limiting.md). Treat it as
request-log metadata under your privacy policy.

## Attempt state machine

| Status      | Meaning |
| ----------- | --- |
| `pending`   | Live or awaiting reconciliation |
| `settled`   | Wallet-verified payment; never overwritten |
| `expired`   | Closed unpaid |
| `failed`    | Wallet reported the invoice failed |
| `attention` | Needs an operator — surface this internally, never to the payer |

Only `pending` attempts are reconciled. Settlement is write-once per
attempt. `onPaid` runs only for the first settled attempt on a reference; a
second payment to a sibling invoice is recorded and never fulfills again.

An unpaid attempt is not closed by your server clock. The library waits for
a successful wallet scan at or after expiry, plus a grace window.

## Live attempts

An order has one live payment session. Within it, at most one live attempt
per rail or asset, so a payer can switch methods. Your application never
sees that vocabulary — an order is unpaid or paid.

One row holds at most one provider swap order. A swap retry creates another
row.

## Escape hatch

If no supported `db` handle can reach your persistence, implement
`PaymentRepository` and pass it as `payments` instead of `db`. You then own
commit locking, the first-settlement claim, reconciliation transitions, and
`claimReconcileGate` (or pass `opportunisticReconcile: false`).

This is the advanced path, not the quickstart. See
[Node ORM recipes](node-orms.md) and the interface in `@openreceive/http`.

Rails applications get the migration from
`bin/rails generate openreceive:install`. The `OpenReceivePayment` model is
engine-owned. See the [Rails quickstart](quickstart-rails.md).

Python hosts get the same two tables in the same shape (datetime columns,
JSON, snake_case — the Rails schema, not the JS one, so one engine per table
still holds). Django ships them as a migration inside the `openreceive.django`
app (`manage.py migrate`), with the ORM-backed repository and the same
per-reference lock per backend: `pg_advisory_xact_lock(hashtextextended(reference, 8210223))`
on PostgreSQL, `GET_LOCK` around the transaction on MySQL, the transaction
boundary on SQLite — give a SQLite database `OPTIONS = {"transaction_mode": "IMMEDIATE"}`
so concurrent commits queue rather than fail. FastAPI, Flask and plain WSGI
hosts render the same DDL with `openreceive scaffold payments --alembic`
or `--sql`. See the [Django quickstart](quickstart-django.md) and the
[FastAPI quickstart](quickstart-fastapi.md).

PHP hosts render the same two tables (the Rails shape again) with
`OpenReceive\Storage\PaymentsSchema::statements($dialect)` — `pgsql`, `mysql`
or `sqlite` — and run the statements through their own migration tool
(`PaymentsSchema::dropStatements()` is the `down()`); `PaymentsSchema::migrate($db)`
is the one-call form for a script. The repository is `SqlPaymentRepository`
over `PdoConnection`, with the same lock per dialect (`pg_advisory_xact_lock`,
`GET_LOCK` released in `finally`, `BEGIN IMMEDIATE` plus `PDO::ATTR_TIMEOUT`
on SQLite), and it never selects `swap_data` into a public array. The engine
refuses to serve a database whose `openreceive_meta` names a NEWER schema
version than the installed package. See the [PHP quickstart](quickstart-php.md).
