# Host storage

OpenReceive has no storage configuration. Do not give it a database or Redis connection and
do not run OpenReceive migrations.

The host application stores, on its existing order row:

```text
payment_hash                         nullable, unique
paid_at                              nullable, write-once
swap_data                            optional server-only JSON/text
```

The order row guards invoice creation. Commit `payment_hash` before displaying the checkout.
If a live hash already exists, reuse the host's committed attempt; if a concurrent compare-and-
set loses, withhold the newly minted invoice. `paid_at` is terminal and duplicate callbacks do
not repeat fulfillment.

Applications may retain invoices or audit details for their own needs, but OpenReceive never
requires them.
