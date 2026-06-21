# Mobile Apps

Mobile apps are checkout clients, not NWC wallet backends. OpenReceive live
checkout always needs a server component that owns the receive-only NWC secret.

Use the Node framework quickstart for the current working backend reference:

```text
docs/01-quickstart-node.md
```

## Supported Shape

A mobile app may:

- call a merchant backend to create an invoice
- display amount, BOLT11 invoice text, QR data, and payment status
- copy the invoice
- open a Lightning wallet through a platform deep link
- poll an authorized lookup endpoint
- subscribe to server-sent or push-style status updates exposed by the backend

A mobile app must not:

- store `OPENRECEIVE_NWC`
- create live invoices directly through NWC
- call wallet `lookup_invoice` directly
- include NWC secrets in app bundles, logs, screenshots, analytics, crash
  reports, support tickets, or test fixtures

## Backend Requirement

The backend owns:

- receive-only NWC configuration
- wallet preflight
- invoice creation
- idempotency
- polling and notification listeners
- settlement verification
- app-owned settlement actions

Mobile UI should treat events and polling responses as display state. The
backend must remain the settlement authority.

## Future SDKs

Native mobile UI kits can wrap display-safe behavior after backend conformance
is stable. They should share the same visual payload rules as
`@openreceive/browser`, `@openreceive/elements`, and `@openreceive/react`.

Do not publish a native mobile live-checkout SDK that embeds NWC or promises
pure frontend checkout.
