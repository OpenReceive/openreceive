# Mobile Apps

Mobile apps are checkout clients, not NWC wallet backends. OpenReceive live
checkout always needs a server component that owns the receive-only NWC secret.

Use the Node framework quickstart for the current working backend reference:

```text
docs/guides/quickstart-node.md
```

## Supported Shape

A mobile app may:

- call your backend to create an invoice
- display amount, BOLT11 invoice text, QR data, and payment status
- copy the invoice
- open a Lightning wallet through a platform deep link
- poll a backend lookup endpoint protected by your app when needed
- subscribe to server-sent or push-style status updates exposed by the backend

A mobile app leaves these on the backend:

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
- route-driven lookup and optional one-shot poll recovery
- settlement verification
- app-owned settlement actions

Mobile UI treats lookup and polling responses as display state. The backend
remains the settlement authority.

## Native UI Kits

Native mobile UI kits can wrap display-safe behavior after backend conformance
is stable. They will share the same visual payload rules as
`@openreceive/browser`, `@openreceive/elements`, and `@openreceive/react`.

Live checkout still goes through your backend; native UI kits
will stay on the display-safe side of that boundary.
