# Rails quickstart

Install the gem, then run:

```sh
bin/rails generate openreceive:install
bin/rails db:migrate
```

The generator:

- mounts `OpenReceive::Engine` at `/openreceive`;
- writes `config/initializers/openreceive.rb`;
- creates the host-owned `OpenReceivePayment` model;
- creates an `openreceive_payments` migration.

It does not alter `orders`. An order has many payment attempts. The generated
model locks the existing order row while appending an attempt, so concurrent
checkout requests cannot expose two live invoices.

The default assumes `Order` with a bigint primary key. Common alternatives:

```sh
# UUID orders
bin/rails generate openreceive:install --order-primary-key-type=uuid

# A host model/table with another name
bin/rails generate openreceive:install \
  --order-model=Purchase \
  --order-table=purchases

# No database foreign key
bin/rails generate openreceive:install --skip-foreign-key
```

Review the generated migration before running it. `order_id` is indexed but not
unique; `payment_hash` is globally unique. The table also stores nullable
write-once `paid_at`, required `expires_at`, and optional server-only
`swap_data`.

One row represents at most one provider swap order. Retrying a terminal swap
creates another payment row and a fresh Lightning invoice; it does not append
provider orders inside `swap_data`.

Supply the receive-only wallet connection as `ENV["NWC_URI"]`. For local
development, a Rails application may load the ignored root `.env` with its
usual environment loader. In production, use the deployment platform's secret
manager.

## Configure host policy and price

The generated initializer includes working payment selection and commit hooks.
Replace its example policy and amount fields with the host application's real
authorization and order-price logic:

```ruby
config.authorize = ->(context) { OpenReceiveOrderPolicy.authorized?(context) }

# Generated resolve_checkout loads Order and OpenReceivePayment separately.
# Keep the amount sourced from the trusted order:
amount = { currency: order.currency, value: order.total.to_s }
```

Payment checks and swap operations send `order_id` plus the displayed
`payment_hash`. `OpenReceivePayment.selected_for` verifies that the attempt
belongs to the authorized order before returning server-only `swap_data`.

`OpenReceivePayment.commit_attempt!`:

1. locks the order;
2. accepts an idempotent repeat of the same hash;
3. rejects an already-paid order;
4. rejects another unexpired attempt;
5. appends the new attempt before payer instructions are returned.

An expired unpaid row remains as history. A later checkout can append another
row for the same order.

## Reconciliation and fulfillment

Run wallet reconciliation through the host application's normal job/process
system. The generated initializer includes this copy-ready callback:

```ruby
OpenReceive.config.service.watch_payments(
  on_paid: lambda do |event|
    OpenReceivePayment.mark_paid_once!(
      payment_hash: event.fetch("payment_hash"),
      paid_at: event.fetch("paid_at")
    ) do |order, payment, first_for_order|
      FulfillOrder.call(order, payment: payment) if first_for_order
    end
  end
)
```

The payment row and host fulfillment share one transaction. Duplicate `onPaid`
delivery is harmless. If two historical attempts genuinely settle, both rows
retain their `paid_at`, while `first_for_order` permits fulfillment only once.

## Swap secrets

The Ruby server recognizes `LSC_URI_PRIMARY` and `LSC_URI_BACKUP` using the
shared [Lightning Swap Connect](lightning-swap-connect.md) vectors. A Rails host
that enables swaps supplies provider adapters through `config.swap_providers`.

The generated model filters `swap_data` from Active Record inspection and
ordinary serialization. Do not explicitly serialize it, log it, or return it
from a host API; it may contain a provider credential.
