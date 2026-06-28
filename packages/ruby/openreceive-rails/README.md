# OpenReceive Rails

This package is the first Rails adapter slice. It provides a small server-side
adapter that can be used from Rails controllers.

Implemented proof pieces:

- idempotent invoice creation through an injected receive-only client
- server-side status refresh through one bounded NWC `list_transactions` page
- duplicate-safe fulfillment tracking using the configured store
- durable transaction scan gate and per-window cursor metadata
- SQLite invoice store resolver for `OPENRECEIVE_STORE`
- install generator skeleton that copies the controller, view, and route templates
- optional mounted engine route/controller surface for invoice status proof work
- Hotwire/Turbo invoice partial for display-safe status updates

Payment verification happens server-side; fulfillment should be idempotent by
the app's order id.

The Rails surface is still initial proof work and needs realignment with the
current Node DX before the Rails lane is a primary supported path. It does not
ship app ActiveRecord invoice models or OpenReceive invoice migrations.
