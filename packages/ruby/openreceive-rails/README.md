# OpenReceive Rails

This package is the first Rails adapter slice. It provides a small server-side
adapter that can be used from Rails controllers or jobs.

Implemented proof pieces:

- idempotent invoice creation through an injected receive-only client
- backend lookup settlement for lookup, route-triggered sweep, and poll recovery
- controller-level invoice access checks in the proof adapter
- duplicate-safe settlement action tracking using the configured store
- bounded route-triggered sweep after OpenReceive create/show routes
- internal verification for optional one-shot poll jobs
- diagnostics for store ownership/schema, NWC, and poll readiness
- package-owned SQLite invoice store resolver for `OPENRECEIVE_STORE`
- install generator skeleton that copies the controller, poll job, view, rake
  task, and route templates
- generated `openreceive:doctor` and `openreceive:poll` rake tasks
- optional mounted engine route/controller surface for invoice proof work
- Hotwire/Turbo invoice partial for display-safe status updates

Route-triggered recovery and optional poll recovery use backend
`lookup_invoice`; settlement actions must be idempotent by `payment_hash`.

The Rails surface is still initial proof work and needs realignment with the
current Node DX before the Rails lane is a primary supported path. It does not
ship app ActiveRecord invoice models or OpenReceive invoice migrations.
