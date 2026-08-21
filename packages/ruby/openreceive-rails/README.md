# openreceive-rails

Mountable receive-only OpenReceive engine. The engine owns the
`OpenReceivePayment` attempt model (statuses `pending`, `settled`, `expired`,
`failed`, `attention`), its per-order commit locking, settlement write-once, and
the reconciliation state machine. The install generator mounts the routes and
emits the initializer plus one migration creating both engine tables
(`openreceive_payments` and the `openreceive_meta` reconcile gate):

```sh
bin/rails generate openreceive:install
bin/rails db:migrate
```

The quickstart host contract is `config.authorize`, `config.load_order`,
`config.amount_for_order`, and `config.on_paid` (run inside the settlement
transaction, only for the order's first settled attempt). Hosts with a custom
repository may instead configure `resolve_checkout` and `on_checkout_created`
together as the advanced escape hatch.

Settlement runs on the request path by default: every engine route runs one
opportunistic reconcile pass, serialized across all Puma workers by that
durable `openreceive_meta` gate (`config.opportunistic_reconcile` disables or
tunes it). The optional
`bin/rails openreceive:notifications` worker listens for wallet notifications
and reconciles periodically; `OpenReceive::ReconcileJob` and
`bin/rails openreceive:reconcile` remain one-shot primitives. Closure of an
unpaid attempt requires a successful wallet scan at or after expiry plus the
shared grace window — a local clock alone never closes a row.

Use `--order-model`, `--order-table`, and `--order-primary-key-type` to match
the host schema. The receive-only wallet URI loads from `ENV["NWC_URI"]`; boot
fails closed when the connection advertises spend methods unless
`config.allow_spend_capable_wallet` or `OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC`
overrides it. Keep ordinary settings such as `config.price_currencies` in
`config/initializers/openreceive.rb`.
