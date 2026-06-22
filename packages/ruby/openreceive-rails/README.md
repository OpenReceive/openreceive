# OpenReceive Rails

This package is the first Rails adapter slice. It provides a small server-side
adapter that can be used from Rails controllers or jobs.

Implemented now:

- production fail-closed authentication configuration
- idempotent invoice creation through an injected receive-only client
- backend lookup settlement for poll recovery
- authorization hook for app-owned invoice access
- duplicate-safe settlement action tracking using the configured store
- internal verification for one-shot poll jobs
- `doctor` diagnostics for store ownership/schema, NWC, and poll readiness
- package-owned SQLite invoice store resolver for `OPENRECEIVE_STORE`
- install generator skeleton that copies the controller, poll job, view, rake
  task, and route templates
- generated `openreceive:doctor` and `openreceive:poll` rake tasks
- optional mounted engine route/controller surface for `/v1/invoices` and `/v1/poll`
- Hotwire/Turbo invoice partial for display-safe status updates

There is no Rails notification listener or `payment_received` job in the
v0.1-v2 path. Poll recovery uses backend `lookup_invoice`; settlement actions
must be idempotent by `payment_hash`.

The Rails storage surface is still initial proof work and will need full
alignment with the OpenReceive-owned KV contract before the Rails lane is a
primary supported path. It does not ship app ActiveRecord invoice models or
OpenReceive invoice migrations.
