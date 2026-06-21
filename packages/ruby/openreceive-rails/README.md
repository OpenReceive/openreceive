# OpenReceive Rails

This package is the first Rails adapter slice. It provides a small server-side
adapter that can be used from Rails controllers or jobs, plus package-owned
ActiveRecord invoice persistence for the OpenReceive lifecycle rows.

Implemented now:

- production fail-closed authentication configuration
- idempotent invoice creation through an injected receive-only client
- backend lookup as settlement authority before settlement actions
- authorization hook for app-owned invoice access
- duplicate-safe settlement action tracking using the configured store
- internal verification for polling workers
- `doctor` diagnostics for store, migration, NWC, and worker readiness
- payment notification handling where the notification is only a passive hint
  and backend lookup remains settlement authority
- ActiveRecord invoice store plus migration and model templates for the invoice
  storage shape
- install generator skeleton that copies the controller, jobs, channel,
  migration, model, and rake task templates and prints the route snippet
- generated `openreceive:doctor`, `openreceive:poll`, and `openreceive:listen` rake tasks for
  separate backend poll/listen processes
- package-owned OpenReceive invoice persistence inside the Rails database; the
  host app configures metadata and settlement hooks instead of hand-rolling
  invoice/idempotency tables
- production fail-closed checks that reject the in-memory test store
- optional mounted engine route/controller surface for `/v1/invoices`
- Hotwire/Turbo invoice partial for passive status updates

Run the poll and listen tasks as separate backend processes or worker roles.
Do not run the long-lived loops as threads inside the web request process.

It does not include full real-wallet Ruby notification coverage yet.
