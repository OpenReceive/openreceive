# IMPORTAT NOTE

this is a brand-new project, we don't yet have users, it's ok to make breaking api changes, we want to maximize user ease and developer experience..

# OpenReceive Agent Rules

These rules apply to Codex, Claude Code, Copilot coding agents, and human
contributors working in this repository.

## Non-Negotiables

- Do not expose receive-only NWC codes to browser code, mobile apps, logs, tests,
  screenshots, docs, source maps, or demo assets.
- OpenReceive receive-checkout APIs never expose send-payment methods.
- Notifications are passive hints. Backend status refresh is the settlement authority.
- Settlement requires `settled_at` or `transaction_state/state == "settled"`.
  A preimage alone is corroborating proof, not final proof.
- Use `amount_msats` for millisatoshis in OpenReceive public payloads. Do not
  use ambiguous `amount` outside raw NIP-47 request/response handling.
- Use exact integer/decimal money math. Do not use binary floats for fiat math.
- If changing a schema, update the relevant test vectors in the same change.
- If adding invoice creation behavior, include idempotency tests.
- If adding settlement behavior, include duplicate/replay-safe tests.
- Do not duplicate provider data, supported currencies, status refresh cadence,
  settlement rules, or demo product data.

## Testing

Run the smallest relevant command while iterating:

```sh
npm test
```

Before declaring work done, run the real local gate:

```sh
npm run test:ci
```

If `npm run test:ci` is too broad for a narrow change, run at minimum:

```sh
npm run typecheck && npm run test:js
```

When touching live wallet behavior, also run:

```sh
npm run test:live:nwc
```

The live command must skip clearly when `OPENRECEIVE_NWC` is not configured.

## Private Boundary

Do not add private openreceive.org app code, private infrastructure inventory,
host IPs, deployment credentials, analytics code, product landing pages, or
private business logic to this public repository.
