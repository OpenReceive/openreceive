# Security

OpenReceive's main security promise is simple: the receive-only NWC code stays
server-side, and products unlock only after backend-verified settlement.

## Receive-only NWC code

A receive-only NWC code can create invoices and reveal wallet metadata. It must
not appear in browser code, mobile apps, source maps, logs, screenshots,
errors, or test fixtures.

## Secrets and deployment

Treat NWC codes and swap provider credentials as private server-only
configuration:

- Commit `openreceive.yml.example`, not real `openreceive.yml` files.
- Do not commit `nwc` or swap provider credentials.
- Mount or inject `openreceive.yml` at runtime from the host or platform secret
  store. Do not bake it into build artifacts or demo images.
- Use separate credentials for demos/staging vs production. Rotate after
  accidental exposure, staff changes, and before going live.

Local YAML (gitignored) — NWC is required; store/namespace have defaults:

```yaml
nwc: nostr+walletconnect://...
```

Omit `store` to adopt a Postgres `DATABASE_URL` when present, or
fall back to `local-sqlite` on durable single-machine hosts. Details:
[Storage](storage.md).

`npm run scan:secrets` rejects likely NWC strings and tracked local config.
`npm run scan:client-bundles` scans demo bundles after `npm run build:demo`.

Logs may include invoice ids, payment hashes, amounts, and payment status. Logs
must not include raw NWC URIs, client secrets, signed status/refresh URLs, or
bearer tokens.

## Settlement

The frontend may show passive progress, but it never unlocks products. Your
backend `onPaid` hook runs only after OpenReceive verifies the payment
server-side. A preimage alone is not enough.

## App auth

Use the host app's sessions, tokens, policies, or guest checkout authorization
for any checkout or status route that should not be public.

With the mounted routes (recommended):

- `prepareCheckout` / `prepare_checkout` is required and is the sole price
  authority on **POST `/prepare`**. Client `amount` / `sats` / `usd` on the
  create body are rejected.
- Order status and swap reads are gated for you (and/or your `authorize` hook).
- Admin sweep fails closed unless `authorize` opts in — see
  [Authorization](authorization.md).
- Optional background settlement sweeps (`startSweeper` or your own cron) must
  run server-side and keep the receive-only NWC code out of browser code.

If you call service methods from your own controllers instead, recompute the cart
total on the server before `getOrCreateCheckout`, and authorize status reads the
same way you authorize any other private order route — see
[Custom Controller Integration](../internal/custom-controller-integration.md).

## Browser defaults

- Deny credentialed cross-origin access by default.
- Never combine wildcard CORS with credentials.
- Use CSRF protection for cookie-authenticated POST routes.
- Return `Cache-Control: no-store` for invoice, status, and refresh responses.
- Avoid logging signed status or refresh URLs.
- Keep private wallet details out of public checkout responses.

## Examples

Local Hello Fruit examples must use low invoice amounts, rate limits, separate
receive-only NWC codes, and logs that redact those codes. Public product demos
live on openreceive.org outside this repository.
