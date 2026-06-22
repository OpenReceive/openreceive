# Framework Auth And Browser Security

OpenReceive framework adapters mount into the app you already deploy. They do
not define a separate user-auth system.

## Route Ownership

The app decides who can create, read, refresh, look up, and run recovery for an
invoice.

Typical rules:

- `POST /openreceive/v1/invoices` requires app auth, a cart/session token, or a
  guest checkout token.
- `GET /openreceive/v1/invoices/{invoice_id}` requires ownership of the
  invoice, order, cart, or checkout session.
- `POST /openreceive/v1/invoices/lookup` is strongly authorized. Keep
  `payment_hash` and BOLT11 lookup behind normal order, cart, checkout, or
  service authorization.
- `POST /openreceive/v1/invoices/{invoice_id}/refresh` requires ownership of
  the old invoice and only creates a linked replacement after expiry or failure.
- `POST /openreceive/v1/poll` requires `auth.poll` or `OPENRECEIVE_CRON_SECRET`
  and is intended for platform schedulers or operator tooling.

## CSRF

Cookie-authenticated POST routes need CSRF protection. The Express adapter
accepts a `csrf.verify(req)` hook so the host app can use its existing CSRF
middleware or token verification.

## CORS

Start with credentialed cross-origin access disabled, then add explicit origins
for the domains that need it.

```ts
cors: {
  allowed_origins: ["https://shop.example"],
  credentials: true
}
```

## Lookup Authorization

Lookup by `payment_hash` or BOLT11 invoice can reveal payment status. Treat it
as sensitive. Configure the adapter so only the current user, cart, order,
checkout session, or backend service principal for that invoice can inspect it.

Lookup routes are gated status refreshes. They may return stored state without
calling the wallet when the per-invoice cooldown or global token bucket blocks a
new wallet lookup.

## Settlement Actions

Host apps may provide a backend settlement action hook. The adapter calls it
only after wallet lookup proves settlement, then marks the invoice settlement
action completed. If no hook is configured, the adapter may complete that
boundary as a no-op after backend settlement is proven.

Write hooks as idempotent backend actions. They are delivered at least once and
should deduplicate by `payment_hash` or use a conditional app-store update.

## Demo Mode

`unsafeAllowUnauthenticatedDemoMode` is only for local or deliberately public
low-value demos. Production apps provide explicit auth, CSRF hooks, and poll
authorization.
