# OpenReceive Agent Rules

These rules apply to Codex, Claude Code, Copilot coding agents, and human
contributors working in this repository.

## Non-Negotiables

- Do not expose NWC secrets to browser code, mobile apps, logs, tests,
  screenshots, docs, source maps, or demo assets.
- Do not implement live checkout in pure frontend code.
- OpenReceive receive-checkout APIs never expose send-payment methods.
- Notifications are passive hints. Backend lookup is the settlement authority.
- Settlement requires `settled_at` or `transaction_state/state == "settled"`.
  A preimage alone is corroborating proof, not final proof.
- Use `amount_msats` for millisatoshis in OpenReceive public payloads. Do not
  use ambiguous `amount` outside raw NIP-47 request/response handling.
- Use exact integer/decimal money math. Do not use binary floats for fiat math.
- If changing a schema, update the relevant test vectors in the same change.
- If adding invoice creation behavior, include idempotency tests.
- If adding settlement behavior, include duplicate/replay-safe tests.
- Do not duplicate provider data, supported currencies, polling cadence,
  settlement rules, or demo product data.

## v0.1 Contract Ownership

Until the v0.1 Express reference path is green, shared contract files need lead
ownership:

- `spec/schemas/**`
- `spec/test-vectors/**`
- `spec/data/**`
- `docs/adr/**`
- `docs/v0.1-scope-lock.md`
- `packages/js/core/src/nwc/**`

Do not add a new SDK, framework adapter, demo, or provider-data package unless
the v0.1 schemas, vectors, and Express reference implementation already cover
the behavior.

## Testing

Run the smallest relevant command before finishing:

```sh
npm test
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
