# Security

OpenReceive's main security promise is simple: the receive-only NWC code stays
server-side, and products unlock only after backend-verified settlement.

## Receive-Only NWC Code

A receive-only NWC code can create invoices and reveal wallet metadata. It must
not appear in browser code, mobile apps, source maps, logs, screenshots,
errors, or test fixtures.

## Settlement

The frontend may show passive progress, but it never unlocks products. Your
backend `onPaid` hook runs only after OpenReceive verifies the payment
server-side. A preimage alone is not enough.

## App Auth

Use the host app's sessions, tokens, policies, or guest checkout authorization
for any checkout or status route that should not be public.

Default route policy:

- Order creation is protected by app auth, cart/session token, or guest
  checkout token. The backend recomputes the cart total before calling
  OpenReceive.
- Order status reads require ownership of the invoice, order, cart, or checkout
  session.
- Lookup by `payment_hash` happens behind your `/order_status` or equivalent
  app route when payment status should not be public.
- Optional scheduler recovery runs server-side with `openreceive poll --once`.

## Browser Defaults

- Deny credentialed cross-origin access by default.
- Never combine wildcard CORS with credentials.
- Use CSRF protection for cookie-authenticated POST routes.
- Return `Cache-Control: no-store` for invoice, lookup, and refresh responses.
- Avoid logging signed lookup or refresh URLs.
- Keep private wallet details out of public checkout responses.

## Demos

Public demos must use low invoice amounts, rate limits, separate receive-only NWC
codes, and logs that redact those codes.
