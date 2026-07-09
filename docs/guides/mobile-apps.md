# Mobile Apps

Mobile apps are checkout clients, not NWC wallet backends. OpenReceive live
checkout always needs a server component that owns the receive-only NWC code.

Use the Node framework quickstart for the current working backend reference:

```text
docs/guides/quickstart-node.md
```

## Supported Shape

A mobile app may:

- call your backend to create/persist an **order** (OpenReceive never mints orders)
- create a checkout against your mounted OpenReceive routes (`{ order_id }` only —
  no client price; present the `order_access_token` as `Authorization: Bearer`)
- display amount, BOLT11 invoice text, QR data, and payment status
- copy the invoice
- open a Lightning wallet through a platform deep link
- poll `{prefix}/orders/{order_id}` with the capability token when needed
- subscribe to server-sent or push-style status updates exposed by the backend

A mobile app leaves these on the backend:

- store `OPENRECEIVE_NWC`
- create live invoices directly through NWC
- call wallet APIs directly
- include receive-only NWC codes in app bundles, logs, screenshots, analytics, crash
  reports, support tickets, or test fixtures

## Backend Requirement

The backend owns:

- receive-only NWC code
- wallet setup
- host order creation + required `getCheckoutAmount` pricing
- invoice creation (via mounted routes or service methods)
- idempotency
- payment status refresh
- payment verification
- the `onPaid` fulfillment path

Mobile UI treats status and polling responses as display state. The backend
`onPaid` path remains the fulfillment authority.

## Native UI Kits

Native mobile UI kits can wrap display-safe behavior after backend conformance
is stable. They will share the same visual payload rules as
`@openreceive/browser`, `@openreceive/elements`, and `@openreceive/react`.

Live checkout still goes through your backend; native UI kits
will stay on the display-safe side of that boundary.
