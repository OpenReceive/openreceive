# Framework Auth And Browser Security

OpenReceive framework adapters mount into the app you already deploy. They do
not define a separate user-auth system.

## Route Ownership

The app decides who can create, read, look up, and subscribe to an invoice.

Typical rules:

- `POST /openreceive/v1/invoices` requires app auth, cart/session token, or a
  guest checkout token.
- `GET /openreceive/v1/invoices/{invoice_id}` requires ownership of the
  invoice, order, cart, or checkout session.
- `POST /openreceive/v1/invoices/lookup` is server-side or strongly
  authorized. Do not expose `payment_hash` lookup as a public status oracle.
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

Signed event URLs must:

- Be scoped to one invoice.
- Expire quickly.
- Avoid sensitive query parameter names.
- Use `Referrer-Policy: same-origin` or stricter.
- Avoid logging full URLs.

The event payload is still passive. It can update UI, but it must not fulfill a
product by itself.

## Lookup Authorization

Lookup by `payment_hash` or BOLT11 invoice can reveal payment status. Treat it
as sensitive. The adapter must check that the current user, cart, order,
checkout session, or backend service principal may inspect that invoice before
returning status.

## Demo Mode

`unsafeAllowUnauthenticatedDemoMode` is only for local or deliberately public
low-value demos. Production apps should provide explicit auth and CSRF hooks.
