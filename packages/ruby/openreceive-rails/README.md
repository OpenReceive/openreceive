# OpenReceive Rails

This package is the first Rails adapter slice. It provides a small server-side
adapter that can be used from Rails controllers or jobs, plus package-owned
ActiveRecord invoice persistence for the OpenReceive lifecycle rows.

Implemented now:

- production fail-closed authentication configuration
- idempotent invoice creation through an injected receive-only client
- backend lookup settlement for polling workers
- authorization hook for app-owned invoice access
- duplicate-safe settlement action tracking using the configured store
- internal verification for polling workers
- `doctor` diagnostics for store, migration, NWC, and worker readiness; the
  doctor task fails if the app still uses the Ruby in-memory test store
- payment notification handling; trusted `payment_received` events settle the
  matching invoice directly
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
Run both tasks; polling remains the fallback when notifications do not arrive.

It does not include full real-wallet Ruby notification coverage yet.
