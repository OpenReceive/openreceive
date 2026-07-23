# openreceive-rails

Mountable receive-only OpenReceive engine. The install generator mounts the
routes and creates host-owned `OpenReceivePayment` model/migration scaffolding:

```sh
bin/rails generate openreceive:install
bin/rails db:migrate
```

`openreceive_payments` stores multiple payment attempts per host order. The
generated commit method locks the order, permits one live attempt, and persists
`payment_hash` plus optional server-only `swap_data` before payer instructions
are returned. The runtime accepts no database configuration or storage adapter.

Use `--order-model`, `--order-table`, and `--order-primary-key-type` to match the
host schema. The receive-only wallet URI loads from `ENV["NWC_URI"]`; keep
ordinary settings such as `config.price_currencies` in
`config/initializers/openreceive.rb`.
