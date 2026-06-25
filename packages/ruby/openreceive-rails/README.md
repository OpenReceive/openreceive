# OpenReceive Rails

This package is the first Rails adapter slice. It provides a small server-side
adapter that can be used from Rails controllers or jobs.

Implemented proof pieces:

- idempotent invoice creation through an injected receive-only client
- server-side payment verification for status and optional recovery
- duplicate-safe fulfillment tracking using the configured store
- optional recovery after a restart or closed browser window
- internal verification for optional scheduled jobs
- package-owned SQLite invoice store resolver for `OPENRECEIVE_STORE`
- install generator skeleton that copies the controller, poll job, view, rake
  task, and route templates
- generated `openreceive:poll` rake task for optional scheduled recovery
- optional mounted engine route/controller surface for invoice proof work
- Hotwire/Turbo invoice partial for display-safe status updates

Payment verification happens server-side; fulfillment should be idempotent by
the app's order id.

The Rails surface is still initial proof work and needs realignment with the
current Node DX before the Rails lane is a primary supported path. It does not
ship app ActiveRecord invoice models or OpenReceive invoice migrations.
