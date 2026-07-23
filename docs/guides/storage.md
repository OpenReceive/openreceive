# Host storage

OpenReceive's runtime has no storage configuration. Do not give it a database
or Redis URL. The host application installs one payment-attempt table in its
existing database:

```text
openreceive_payments
  order_id      required, indexed; not unique
  payment_hash  required, unique
  paid_at       nullable, write-once per attempt
  expires_at    required
  swap_data     optional server-only JSON/text
  timestamps
```

An order can have many attempts. Unpaid expired rows remain available for
wallet reconciliation; `paid_at = null` alone does not mean an attempt is live.

One row has at most one swap attempt. `swap_data` belongs to that row's single
provider order and is bound to the same row's `payment_hash`. A swap retry
creates another payment row with a fresh invoice hash; never point multiple
provider orders at one Lightning invoice.

Repeated status, recovery, and refund requests are not new attempts. They
continue to operate on the existing row's provider order.

Before inserting, lock the existing order row and reject another paid or
unexpired attempt. This database serialization boundary makes concurrent
creates converge without an OpenReceive runtime idempotency store. Commit the
new row before displaying payer instructions.

On settlement, find the row by `payment_hash`, lock its order, set that row's
`paid_at` once, and fulfill only if no sibling attempt was already paid. Record
an accidental second settlement without repeating fulfillment.

Rails users receive model and migration scaffolding from
`openreceive:install`. Node users use their existing ORM; see
[Node ORM Recipes](node-orms.md).
