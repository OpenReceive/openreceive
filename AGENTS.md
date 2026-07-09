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

### Shipped routes, tiers, and capability tokens

- OpenReceive ships the routes (`@openreceive/http` + adapters; `openreceive-rails`
  engine). The host keeps 100% of authentication. OpenReceive NEVER inspects the host
  session — it only calls the host `authorize`/`resolveAmount`/`rateLimit` hooks and obeys
  their return values (inversion of control).
- Three tiers: Tier 1 anonymous-capable (checkout.create, rates); Tier 2 capability-token
  scoped (order/checkout reads, swap actions on your own order); Tier 3 privileged and
  **fails closed** (invoice.sweep) — with no `authorize` policy, Tier 3 returns 403.
- The create-checkout route MUST NOT trust a client-supplied price. Use the host
  `resolveAmount` hook for the authoritative amount.
- Capability tokens are per-order, ≥128-bit, URL-safe, returned once as `order_access_token`.
  Store only the sha256 hash. Token hashing must be identical across ports (verified by
  `spec/test-vectors/capability-token.json`).
- The route contract is `spec/openapi/openreceive-http.v1.yaml`. Any change to a route or its
  shapes must keep the Node adapters and the Rails engine byte-equal (HTTP golden vectors).

## Testing

Prefer the smallest relevant check while iterating. Do not run slow full-suite
commands after every code change unless the change is broad, risky,
release-like, or the user explicitly asks for it.

Fast/default checks:

```sh
npm test
```

Use this for schema/docs/secret-safety/tooling validation, or as a quick repo
sanity check.

For most JS/TS code changes, run the narrowest relevant test file first, then at
minimum:

```sh
npm run typecheck && npm run test:js
```

If the change only touches a small area, it is okay to run a focused test command
instead of all JS tests while iterating, for example:

```sh
node --import tsx --test tests/v0.1/node-service.test.mjs
```

Run the full local gate only when the change has broad blast radius, touches
release/deployment/package surfaces, changes generated contracts or schemas, or
the user asks for final full verification:

```sh
npm run test:ci
```

When touching live wallet behavior, also run:

```sh
npm run test:live:nwc
```

The live command must skip clearly when `OPENRECEIVE_NWC` is not configured.

The Ruby port is a second settlement engine that must match the Node engine on the
shared vectors. Run it with:

```sh
npm run test:ruby
```

The shared `spec/test-vectors/*` (including the cross-language
`idempotency-canonical-json.crosslang.json` and `capability-token.json`) and the HTTP
golden vectors (`spec/test-vectors/http-golden/*`) are the conformance oracle that keeps
the two engines from silently diverging on money — run them in BOTH languages when
touching settlement, money math, idempotency, tokens, or route behavior.

Before declaring work done, report exactly which checks were run. If you skip
`npm run test:ci`, say why the narrower checks were sufficient.

## Private Boundary

Do not add private openreceive.org app code, private infrastructure inventory,
host IPs, deployment credentials, analytics code, product landing pages, or
private business logic to this public repository.
