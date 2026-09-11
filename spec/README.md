# spec/

The normative contract: what every OpenReceive engine (JavaScript, Ruby, Python, PHP, and .NET) must agree
on. Four version numbers live here, each meaning one thing.

These contracts cover Lightning checkout and optional swaps from USDT, USDC,
SOL, and ETH. A configured swap provider converts the payer's deposit to BTC
over Lightning in the merchant's wallet; supported assets and networks depend
on the provider. The vectors define when wallet settlement is authoritative.

| Number | Where | Meaning |
| --- | --- | --- |
| `info.version` (`0.4.0` in the OpenAPI, `0.2.0` in the AsyncAPI) | `openapi/*.yaml:4`, `asyncapi/*.yaml:4` | **The contract version — the one to cite.** Semver per document: a breaking change to a route or event bumps the major (minor while `0.x`), an additive change bumps the minor. |
| `v1` in a filename | `openapi/openreceive-http.v1.yaml`, `asyncapi/openreceive-events.v1.yaml` | The major line of that document. It changes only when a new major ships alongside the old one; it is not a version to cite. |
| `vN` in a schema `$id` | `schemas/*.schema.json` (`checkout.v2`, `provider-registry.v4`, …) | Each JSON Schema versions independently, in its `$id`, because schemas are reused across documents. Filenames carry no version so references never churn. |
| `OPENRECEIVE_*_CONTRACT_VERSION` | `packages/js/core/src/generated/contracts.ts` | Generated copies of the two `info.version` values (`npm run generate:models`); `npm run check:generated` fails when they drift. |

`test-vectors/` holds the shared behavior the engines must reproduce, and
`test-vectors/coverage.json` says which engine consumes which family (or why it is
exempt). `data/` holds canonical provider data, `data/kernel-tables.json` (the one
hand-edited copy of the vocabularies and numbers every engine shares) and
`data/swap-state-table.json` (the FixedFloat status → state/reason decision table every
engine interprets) — `npm run generate:models` renders both into the JS, Ruby, C#, PHP and
Python engines. Route or schema changes update their vectors in the same change (AGENTS.md),
and `npm run check` validates all of it.

## Upstream specifications

The wallet side of every engine is written against these documents. NIP-47 was reduced
to a core (`pay_invoice`, `make_invoice`, `lookup_invoice`, `get_balance`, `get_info`) in
2026; the pieces OpenReceive depends on most now live as numbered extensions in the
`nostr-wallet-connect/nwc` repository. Cite the extension, not "NIP-47", when a vector
pins one of them.

| Document | What OpenReceive takes from it | Vectors |
| --- | --- | --- |
| [NIP-47 (core)](https://github.com/nostr-protocol/nips/blob/master/47.md) | connection URI, info event (kind 13194) and its `encryption` tag negotiation, request/response kinds 23194/23195, `make_invoice`, `lookup_invoice`, `get_info`, the transaction object and its `state` values (`pending`, `settled`, `accepted`, `expired`, `failed`), error codes | `nwc-uri-parse`, `nwc-info`, `nwc-request-response`, `make-invoice-validation`, `error-normalization`, `settlement-detection` |
| [NWC-02 Notifications](https://github.com/nostr-wallet-connect/nwc/blob/main/02.md) | `payment_received` payload, kinds 23196 (NIP-04) / 23197 (NIP-44), the rule that a wallet publishing only NIP-44 publishes only 23197 | the notification path in `settlement-detection` and the engines' listener tests |
| [NWC-05 Transaction History](https://github.com/nostr-wallet-connect/nwc/blob/main/05.md) | `list_transactions` params (`from`, `until`, `limit`, `offset`, `unpaid`, `type`), descending creation order, optional `total_count`, and the guidance that clients page at most 20 rows and relays allow 64 KB payloads — the source of `transaction_page_limit` in `kernel-tables.json` | `nwc-request-response`, `wallet-scan-truncation` |
| [NWC-06 Metadata Conventions](https://github.com/nostr-wallet-connect/nwc/blob/main/06.md) | the `metadata` object on invoices and its size limits — the source of `metadata_max_bytes` | `make-invoice-validation` |
| [NWC index](https://github.com/nostr-wallet-connect/nwc/blob/main/README.md) | the list of extensions (03 hold invoices, 04 keysend, 07 deep links, 321 BIP-321 are not used) | — |

