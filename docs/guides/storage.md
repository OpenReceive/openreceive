# Payment storage

Your application owns orders. The library owns the `openreceive_payments`
rows, and those rows live in your database.

OpenReceive never owns orders, users, prices, or fulfillment. It never needs a
separate database, Redis, or migration runner. You run the migration with your
own tools and pass the library a database handle (`db`). The library owns:

- the schema
- locking per reference
- write-once settlement
- the reconciliation state machine

## Schema

`npx openreceive scaffold payments` (or the Rails install generator) writes
the migration. Keep every column it creates:

```text
openreceive_payments
  id             primary key
  reference      required, indexed; many attempts per reference
  payment_hash   required, unique, 64 lowercase hex
  status         pending | settled | expired | failed | attention
  status_reason  nullable operator-facing detail
  paid_at        nullable, write-once
  expires_at     required payer instruction/reuse deadline
  created_at     required wallet creation time or host fallback
  updated_at     required
  inserted_at    required, stamped once
  checkout_data  required payer-safe JSON (bolt11, amount, timestamps)
  swap_data      nullable, server-only provider credential
  client_ip      nullable, captured at invoice creation
```

The same migration also creates `openreceive_meta`. Leave that table in place.
Every instance of your app shares it. It holds:

- the versioned reconcile gate
- bounded scan progress
- audit entries for explicit operator repairs

`checkout_data` lets a page reload serve the same invoice again without
another wallet call. The invoice expiry stored there is the reconciliation
deadline. The swap deposit expiry only controls reuse and display. The snapshot
also records whether the creation time came from the wallet. That way, legacy
or host-supplied timestamps cannot narrow the history the library checks.
Never serialize or log `swap_data`.

SQL you write in `onPaid` goes to your driver unchanged. Use `?` on SQLite and
`$1` on Postgres.

`client_ip` supports the opt-in [rate limiter](rate-limiting.md). Treat it as
request-log metadata covered by your privacy policy.

## Attempt state machine

| Status      | Meaning |
| ----------- | --- |
| `pending`   | Live, or waiting for reconciliation |
| `settled`   | Payment verified by the wallet. Never overwritten |
| `expired`   | Closed unpaid |
| `failed`    | The wallet reported the invoice failed |
| `attention` | Needs an operator. Show this internally, never to the payer |

Only `pending` attempts are reconciled. Each attempt can be settled only once.
`onPaid` runs only for the first settled attempt on a reference. If the payer
also pays a sibling invoice, that second payment is recorded but never
fulfills the order again.

Your server clock alone never closes an unpaid attempt. The library waits for a
complete wallet scan that covers the attempt. That scan must run at or after
the saved wallet invoice expiry plus the 900-second observation grace. A
resumed or truncated scan can find a settlement, but it cannot prove that no
payment arrived.

## Live attempts

An order has one live payment session. Inside that session there is at most one
live attempt per rail or asset, so the payer can switch payment methods. Your
application never deals with those terms. To your app, an order is either
unpaid or paid.

One row holds at most one provider swap order. A swap retry creates a new row.

## Escape hatch

If no supported `db` handle can reach your storage, implement
`PaymentRepository` and pass it as `payments` instead of `db`. You then own:

- commit locking
- the first-settlement claim
- reconciliation transitions
- the atomic `recordSettlementWithFulfillment` callback transaction
- durable `findByPaymentHash` acknowledgment
- lease-based `claimReconcileGate` / `checkpointReconcileGate` progress (or
  pass `opportunisticReconcile: false`)

See the [upgrade and reviewed repair procedure](payment-safety-upgrade.md).

This is the advanced path, not the quickstart. See
[Node ORM recipes](node-orms.md) and the interface in `@openreceive/http`.

Rails applications get the migration from
`bin/rails generate openreceive:install`. The engine owns the
`OpenReceivePayment` model. See the [Rails quickstart](quickstart-rails.md).

Python hosts get the same two tables in the same shape: datetime columns, JSON,
and snake_case. This is the Rails schema, not the JS one, so each table still
has one engine shape. Django ships the tables as a migration inside the
`openreceive.django` app (`manage.py migrate`). It includes the ORM-backed
repository and the same per-reference lock, done per backend:

- PostgreSQL: `pg_advisory_xact_lock(hashtextextended(reference, 8210223))`
- MySQL: `GET_LOCK` around the transaction
- SQLite: the transaction boundary. Give a SQLite database
  `OPTIONS = {"transaction_mode": "IMMEDIATE"}` so concurrent commits wait in
  line instead of failing.

FastAPI, Flask and plain WSGI hosts render the same DDL with
`openreceive scaffold payments --alembic` or `--sql`. See the
[Django quickstart](quickstart-django.md) and the
[FastAPI quickstart](quickstart-fastapi.md).

PHP hosts render the same two tables, again in the Rails shape, with
`OpenReceive\Storage\PaymentsSchema::statements($dialect)`. The dialect is
`pgsql`, `mysql` or `sqlite`. Run the statements through your own migration
tool. `PaymentsSchema::dropStatements()` is the `down()`. For a script,
`PaymentsSchema::migrate($db)` does it in one call. The repository is
`SqlPaymentRepository` over `PdoConnection`. It uses the same lock per dialect:
`pg_advisory_xact_lock`, `GET_LOCK` released in `finally`, and
`BEGIN IMMEDIATE` plus `PDO::ATTR_TIMEOUT` on SQLite. It never selects
`swap_data` into a public array. The engine refuses to serve a database whose
`openreceive_meta` names a NEWER schema version than the installed package.
See the [PHP quickstart](quickstart-php.md).
