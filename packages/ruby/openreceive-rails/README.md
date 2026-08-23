# openreceive-rails

Mountable receive-only OpenReceive engine. The engine owns the
`OpenReceivePayment` attempt model (statuses `pending`, `settled`, `expired`,
`failed`, `attention`), its per-reference commit locking, settlement write-once, and
the reconciliation state machine. The install generator mounts the routes and
emits the initializer plus one migration creating both engine tables
(`openreceive_payments` and the `openreceive_meta` reconcile gate):

```sh
bin/rails generate openreceive:install
bin/rails db:migrate
```

The generated migration supports PostgreSQL, SQLite, and MySQL, and seeds the
shared `schema_version`; on its first database touch the engine refuses to
operate a database whose stored schema version is newer than the gem.

The quickstart host contract is `config.authorize`, `config.amount_for` (the
trusted price for a reference, or `nil` for a 404), and `config.on_paid` (run
inside the settlement transaction, only for the first settled attempt for a reference). The generated
initializer starts with the `OpenReceive::LOGGING_ON_PAID` placeholder, which
only logs settlements — the engine warns every time your application boots
until it is replaced.
Hosts with a custom repository may instead configure `resolve_checkout` and
`on_checkout_created` together as the advanced escape hatch. In production the
engine builds the service (and its wallet preflight) eagerly when your
application boots, so a missing `NWC_URI` or a spend-capable wallet stops the
deploy instead of surfacing as checkout-time 500s.

Settlement runs on the request path by default: every engine route runs one
opportunistic reconcile pass, serialized across all Puma workers by that
durable `openreceive_meta` gate (`config.opportunistic_reconcile` disables or
tunes it). The optional
`bin/rails openreceive:notifications` worker listens for wallet notifications
and reconciles periodically; `OpenReceive::ReconcileJob` and
`bin/rails openreceive:reconcile` remain one-shot primitives. Closure of an
unpaid attempt requires a successful wallet scan at or after expiry plus the
shared grace window — a local clock alone never closes a row.

Because the engine cannot see fulfillment that happens outside it,
`config.on_paid` must be idempotent if any other path can also fulfill an
order — the generated initializer shows the guarded transition. The receive-only wallet URI loads from `ENV["NWC_URI"]`; your
application refuses to start when the connection advertises spend methods unless
`config.allow_spend_capable_wallet` or `OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC`
overrides it. Keep ordinary settings such as `config.price_currencies` in
`config/initializers/openreceive.rb`.
