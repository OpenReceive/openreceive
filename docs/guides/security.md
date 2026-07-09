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

With the mounted routes (recommended):

- Your app creates and persists the order; OpenReceive never mints orders.
- `getCheckoutAmount` is required and is the sole price authority on create.
  Client `amount` / `sats` / `usd` on the create body are rejected.
- Order status and swap reads are gated for you (and/or your `authorize` hook).
- Admin sweep fails closed unless `authorize` opts in — see
  [Authorization](authorization.md).
- Optional background settlement sweeps (`startSweeper` or your own cron) must
  run server-side and keep the receive-only NWC code out of browser code.

If you call service methods from your own controllers instead, recompute the cart
total on the server before `getOrCreateCheckout`, and authorize status reads the
same way you authorize any other private order route.

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
