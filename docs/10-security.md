# Security

OpenReceive's main security promise is simple: wallet secrets stay server-side,
and products unlock only after backend-verified settlement.

## Wallet Secrets

NWC connection strings are secrets. Receive-only NWC is safer than read/write
NWC, but it can still create invoices and reveal wallet metadata. It must not
appear in browser code, mobile apps, source maps, logs, screenshots, errors, or
test fixtures.

## Settlement

The frontend may show passive progress from polling or events, but it never
fulfills an order. Backend lookup is the source of truth. OpenReceive treats an
incoming invoice as settled only when `lookup_invoice` returns `settled_at` or
`state == "settled"`. A preimage alone is not enough.

## App Auth

OpenReceive does not define a user-auth system. Framework adapters must plug
into the host app's sessions, tokens, policies, or guest checkout authorization.

Default route policy:

- Invoice creation is protected by app auth, cart/session token, or guest
  checkout token.
- Invoice reads require ownership of the invoice, order, cart, or checkout
  session.
- Lookup by `payment_hash` is server-side or strongly authorized.
- Event streams use same-site sessions or short-lived signed URLs.

## Browser Defaults

- Deny credentialed cross-origin access by default.
- Never combine wildcard CORS with credentials.
- Use CSRF protection for cookie-authenticated POST routes.
- Return `Cache-Control: no-store` for invoice, lookup, and event responses.
- Avoid logging signed event URLs.

## Demos

Public demos must use low invoice amounts, rate limits, separate receive-only
wallet credentials, and logs that redact secrets.
