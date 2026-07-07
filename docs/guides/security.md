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
- Status refresh happens behind your `/order` or equivalent app route
  when payment status should not be public.
- Optional background settlement sweeps must run server-side and keep the
  receive-only NWC code out of browser code.

## Browser Defaults

- Deny credentialed cross-origin access by default.
- Never combine wildcard CORS with credentials.
- Use CSRF protection for cookie-authenticated POST routes.
- Return `Cache-Control: no-store` for invoice, status, and refresh responses.
- Avoid logging signed status or refresh URLs.
- Keep private wallet details out of public checkout responses.

## Demos

Public demos must use low invoice amounts, rate limits, separate receive-only NWC
codes, and logs that redact those codes.
