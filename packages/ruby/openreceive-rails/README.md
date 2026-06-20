# OpenReceive Rails

This package is the first Rails adapter slice. It provides a small server-side
adapter that can be used from Rails controllers or jobs while the full Rails
engine, migrations, and demos are still being built.

Implemented now:

- production fail-closed authentication configuration
- idempotent invoice creation through an injected receive-only client
- backend lookup as settlement authority before settlement actions
- authorization hook for app-owned invoice access
- duplicate-safe settlement action tracking using the Ruby in-memory store
- internal verification for polling workers
- payment notification handling where the notification is only a passive hint
  and backend lookup remains settlement authority
- ActiveRecord migration and model templates for the invoice storage shape
- install generator skeleton that copies the controller, jobs, channel,
  migration, and model templates and prints the route snippet
- optional mounted engine route/controller surface for `/v1/invoices`
- Hotwire/Turbo invoice partial for passive status updates

It does not include Rails demo apps or real-wallet Ruby smoke coverage yet.
