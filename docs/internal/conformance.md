# Conformance

OpenReceive conformance starts with shared source-of-truth files. SDKs and
adapters should not redefine invoice lifecycle, settlement, polling, idempotency,
or amount rules.

## Required Sources

- `spec/schemas/*.schema.json` define invoice, storage, payment event, rate
  quote, error, and provider-registry shapes.
- `spec/test-vectors/*.json` define amount boundaries, error normalization,
  fiat conversion, idempotency, invoice lifecycle, make-invoice validation, NWC
  info/encryption parsing, NWC request/response mapping, NWC URI parsing,
  polling cadence, provider route selection, settlement detection, and the
  transport-agnostic storage KV contract.
- `spec/openapi/openreceive-http.v1.yaml` defines mounted HTTP routes.
- `spec/asyncapi/openreceive-events.v1.yaml` defines invoice event names and
  payloads.

## Local Gate

Run:

```sh
npm run test:ci
```

That command validates schemas and vectors, scans for secrets, checks generated
contract models for staleness, typechecks the TypeScript packages, runs JS
tests, imports local package build artifacts, builds the demos, scans generated
client bundles for NWC markers, builds the docs index, and runs the live NWC
smoke script when `OPENRECEIVE_NWC` is set.

Run `npm run generate:models` after changing OpenAPI or AsyncAPI contracts.
`npm run check:generated` fails if the checked-in generated model constants no
longer match the source contracts.

`npm run validate` also checks that provider-route vectors are well formed and
that the canonical price-source order remains `static_mock`,
`openreceive_mirror`, `megalithic_mirror`, then `coingecko_direct`.
It also keeps the default live-wallet expected-capabilities fixture aligned
with the documented Rizful example.

## Error Codes

SDKs and adapters must normalize wallet and service failures to the canonical
uppercase codes in `spec/schemas/error.schema.json`. Receive-only paths should
still normalize NIP-47 send-payment errors such as `INSUFFICIENT_BALANCE` and
`PAYMENT_FAILED` so diagnostics match the underlying wallet libraries.

## Settlement Rules

SDKs and adapters must treat an incoming invoice as settled only when
`lookup_invoice` returns `settled_at` or `state == "settled"` /
`transaction_state == "settled"`. A preimage is corroborating data, not final
settlement proof.

Settlement action hooks may run only after that backend lookup settlement
proof. They must be idempotent; replaying lookup or server-side lifecycle
events must not run the app action twice.

## Idempotency Rules

Create-invoice idempotency is scoped to:

```text
namespace + operation + idempotency_key
```

Replaying the same request returns the same invoice. Reusing the same key with a
different request body is a conflict.

Refresh idempotency uses the same scope shape with `operation =
"invoice.refresh"`. Refresh creates a new linked invoice row with
`refreshed_from_invoice_id`; it must not mutate the old invoice in place.

## Live Wallet Smoke

`npm run test:live:nwc` uses `OPENRECEIVE_NWC` when present and skips clearly
when absent. It may load a receive-only NWC code from a local ignored env file when
`OPENRECEIVE_ENV_FILE` points at one. Live runs must use a low-value
receive-only NWC code and must redact the connection string in all output.

The default wallet capability fixture is
`tools/live-nwc-test/expected_capabilities.json`, currently set for the Rizful
profile. Use `OPENRECEIVE_EXPECTED_CAPABILITIES=/path/to/file.json` to test a
different wallet profile without editing the committed default.

The live harness verifies preflight, the metadata-size guard, invoice creation,
initial lookup, and optional trusted notification confirmation when manual
payment waiting is enabled. Polling lookup remains the recovery path when
notifications are unavailable or missed.
Recovery tests must include invoices whose local `expires_at` passed while the
server was down; those invoices stay recoverable until a post-expiry wallet
lookup or post-expiry grace verification closes them.

Do not run live wallet tests on untrusted pull requests with receive-only NWC codes
available.

## Future SDKs

New SDKs should live in one package directory, consume the shared vectors, and
provide one conformance command. They must not add send-payment methods or
frontend NWC behavior to OpenReceive receive-checkout APIs.

## Testkit

`@openreceive/testkit` provides deterministic receive-client fixtures for SDK
and adapter tests. It can create predictable invoices, look them up by invoice
or payment hash, explicitly mark them settled, expired, or failed, and replay
duplicate `payment_received` notifications.

Use `scriptLookupSequence` when a test needs deterministic lookup behavior over
time. A sequence can return pending or terminal wallet states, throw a specific
wallet error, or return a hand-authored lookup result before falling back to the
stored invoice state. This is useful for polling and retry tests that
need to prove lookup remains the settlement authority.

The testkit is not a daemon and does not emulate Nostr relay behavior. It is a
local conformance helper for code paths that already depend on the
`OpenReceiveReceiveNwcClient` interface.

## Mock Wallet

`npm run mock-wallet` starts `tools/mock-wallet`, a deterministic local HTTP
service backed by `@openreceive/testkit`. It exposes `get_info`, `make_invoice`,
`lookup_invoice`, scripted terminal states, scripted lookup sequences,
and deterministic lookup errors for conformance tests.

The mock wallet returns non-payable invoice fixtures. It does not replace live
wallet profile tests, does not prove real BOLT11 routing, and does not emulate a
Nostr relay. Use it for reproducible contract behavior before testing a real
receive-only NWC code with `npm run test:live:nwc`.

## Recovery

OpenReceive v0.1-v2 recovery is poll-only. Tests should cover lookup-gated
interactive refresh, bounded sweeps, one-shot `openreceive poll --once`
recovery, duplicate-safe settlement hooks, and the rule that a preimage alone
is not final settlement proof.
