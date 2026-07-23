# OpenReceive Agent Rules

This is a greenfield project with no compatibility or migration constraint. Optimize for a
small, honest API and a good developer experience.

## Non-negotiables

- OpenReceive has no persistence configuration: no database/Redis URLs, migrations, storage
  adapters, internal payment rows, or durable workflow cursors.
- The host owns orders and prices. Direct server code passes `{ orderId, amount }`; mounted
  HTTP handlers resolve the amount from host-owned data and reject payer-supplied amounts.
- The host stores `payment_hash` before payer instructions are exposed and sets nullable
  `paid_at` once. Duplicate `onPaid` delivery must be harmless.
- A retry or concurrent create must be guarded by the host order row. Do not add an
  OpenReceive idempotency store.
- Receive-only NWC codes must never reach browser/mobile code, logs, tests, screenshots,
  docs, source maps, or demo assets. Receive APIs never expose send-payment methods.
- Notifications are passive hints. Settlement requires `settled_at` or
  `transaction_state/state == "settled"`; a preimage alone is corroborating evidence.
- Use `amount_msats` for millisatoshi values in public results and exact integer/decimal money
  math. Never use binary floats for fiat math.
- Swap provider credentials exist only inside an authenticated encrypted recovery token.
  Provider completion is not wallet settlement; refund decisions refresh provider state.
- Token configuration is a keyring. The first key seals new tokens and retained old keys only
  open tokens during rotation.
- Do not duplicate provider data, supported currencies, settlement rules, polling cadence, or
  demo product data.
- Schema or route changes update their vectors in the same change. Invoice behavior needs
  host-row retry/concurrency tests; settlement behavior needs replay-safe tests.

## Shipped routes and hooks

- `@openreceive/http` adapters and the Rails engine ship the route set in
  `spec/openapi/openreceive-http.v1.yaml`.
- The host keeps authentication. OpenReceive calls required `authorize`, required
  `resolveCheckoutAmount` / `resolve_checkout_amount`, optional `rateLimit`, and required
  `onCheckoutCreated` / `on_checkout_created` hooks.
- Capability, swap-recovery, and refund-confirmation tokens are stateless authenticated
  encrypted envelopes. OpenReceive stores no token hash.
- `onCheckoutCreated` runs before a create response. Failure returns 409 and withholds the
  invoice or swap instructions.

## Testing

Use the smallest relevant test while iterating. The default contract/secret check is:

```sh
npm test
```

For JS/TS changes, run a focused test first and then at minimum:

```sh
npm run typecheck && npm run test:js
```

For broad route, package, contract, schema, release, or deployment changes, run:

```sh
npm run test:ci
```

Wallet behavior also requires `npm run test:live:nwc`; it must skip clearly when `nwc` is not
configured. Ruby is a second settlement engine and must match the shared money, settlement,
token, and HTTP vectors:

```sh
npm run test:ruby
```

Before declaring work done, report the exact checks run and any intentional skip.

## Private boundary

Do not add private openreceive.org application code, infrastructure inventory, host IPs,
deployment credentials, analytics, landing pages, or business logic to this public repo.
