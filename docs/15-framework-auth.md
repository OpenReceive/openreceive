# Framework Auth And Browser Security

OpenReceive framework adapters mount into the app you already deploy. They do
not define a separate user-auth system.

## Route Ownership

The app decides who can create, read, refresh, look up, and subscribe to an
invoice.

Typical rules:

- `POST /openreceive/v1/invoices` requires app auth, cart/session token, or a
  guest checkout token.
- `GET /openreceive/v1/invoices/{invoice_id}` requires ownership of the
  invoice, order, cart, or checkout session.
- `POST /openreceive/v1/invoices/lookup` is server-side or strongly
  authorized. Do not expose `payment_hash` lookup as a public status oracle.
- `POST /openreceive/v1/invoices/{invoice_id}/refresh` requires ownership of
  the old invoice and only creates a linked replacement after expiry or failure.
- `GET /openreceive/v1/invoices/{invoice_id}/events` uses the same ownership
  check as invoice read.

## CSRF

Cookie-authenticated POST routes need CSRF protection. The Express adapter
accepts a `csrf.verify(req)` hook so the host app can use its existing CSRF
middleware or token verification.

## CORS

Defaults should deny credentialed cross-origin access.

Do not combine wildcard CORS with credentials. Configure explicit origins:

```ts
cors: {
  allowed_origins: ["https://shop.example"],
  credentials: true
}
```

## Signed Event URLs

Some browser EventSource flows cannot send custom auth headers. In those cases,
an app may issue a short-lived signed event URL.

The Express adapter can generate and verify those URLs when configured:

```ts
mountOpenReceiveExpressRoutes(app, {
  // other options...
  signedEvents: {
    secret: process.env.OPENRECEIVE_EVENT_URL_SECRET,
    ttlSeconds: 300
  }
});
```

When enabled, `checkout.events_url` includes an `_or_evt` query value scoped to
that invoice. If the query value is missing, the adapter falls back to the
normal `auth.events` hook. If it is present but expired or scoped to another
invoice, the route fails closed.

Signed event URLs must:

- Be scoped to one invoice.
- Expire quickly.
- Avoid sensitive query parameter names.
- Use `Referrer-Policy: same-origin` or stricter.
- Avoid logging full URLs.

The event payload is still passive. It can update UI, but it must not run a
merchant settlement action by itself.

## Lookup Authorization

Lookup by `payment_hash` or BOLT11 invoice can reveal payment status. Treat it
as sensitive. The adapter must check that the current user, cart, order,
checkout session, or backend service principal may inspect that invoice before
returning status.

## Settlement Actions

Host apps may provide a backend settlement action hook. The Express adapter
calls it only after wallet lookup proves settlement, then marks the invoice
settlement action completed and publishes `invoice.settlement_action_completed`.
If no hook is configured, the adapter may complete that boundary as a no-op
after backend settlement is proven.
Hooks must be idempotent and must not trust frontend state or passive event
delivery as action authority.

## Demo Mode

`unsafeAllowUnauthenticatedDemoMode` is only for local or deliberately public
low-value demos. Production apps should provide explicit auth and CSRF hooks.
