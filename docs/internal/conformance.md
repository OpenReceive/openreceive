# Conformance

Every OpenReceive engine must reproduce the same money, settlement, NIP-47 paging, swap
provider, and HTTP behavior. Two things make that checkable rather than aspirational:

- **Shared vectors** under `spec/test-vectors/` feed the real production functions of each
  engine (`tests/crosslang.test.mjs` and the per-topic JS tests; `tools/conformance/ruby-crosslang.rb`
  and the per-gem Ruby tests). A vector never runs against a re-implementation in the validator.
- **Shared tables** in `spec/data/kernel-tables.json` are rendered by `npm run generate:models`
  into every engine, so a closed vocabulary or a fixed number is typed once. `npm run check:generated`
  fails when any rendering is stale; `npm run validate` fails when the OpenAPI document, the JSON
  Schemas, or a vector restates one of them differently.

Conformance requires: pages no larger than 20; dedupe by payment hash; creation-time scan
ranges; preimage-alone rejection; create response only after host commit; replay-safe paid
delivery; and truncated-scan safety (`wallet-scan-truncation` vectors: a scan that ran out of
pages proves nothing about the attempts it never reached — they stay pending).

## The kernel boundary

An engine is two layers. The **kernel** is the behavior the vectors pin; a new engine ports
every row below and proves it against the same files. The **host glue** is everything that
binds the kernel to one platform; it is written fresh per engine and is never shared or
generated. When someone asks "how much of a new language is real work", the answer is: the
kernel rows are bounded and mechanical, the glue is the project.

| Kernel module | Pinned by | JS | Ruby | C# (BTCPay plugin) |
| --- | --- | --- | --- | --- |
| NWC URI parse + redaction | `nwc-uri-parse` | `core/src/nwc/client.ts` | `openreceive/lib/openreceive/core.rb` (`Nwc`) | `Nwc/NwcUri.cs` |
| Wallet capability summary + receive-only preflight | `nwc-info` | `node/src/nwc/normalize.ts` | `openreceive-server/.../wallet_info.rb` | `Nwc/NwcInfo.cs`, `WalletPreflight.cs` |
| NIP-47 request building + reply normalization | `nwc-request-response`, `make-invoice-validation`, `amount-boundaries` | `node/src/nwc/normalize.ts` | `core.rb` (`Nwc`, `Money`) | `ReceiveOnlyNwcClient.cs` |
| Wallet error normalization | `error-normalization` | `node/src/nwc/errors.ts` | `core.rb` (`Nwc.normalize_wallet_error`) | `Nwc/NwcErrors.cs` |
| Settlement classification | `settlement-detection` | `core/src/settlement/` | `core.rb` (`Settlement`) | `Nwc/Settlement.cs` |
| Paged, deduped, truncation-safe wallet walk | `wallet-scan-truncation` | `core/src/payments.ts` | `service.rb` (`reconcile_payments`) + `core.rb` (`Payments`) | `Nwc/WalletScan.cs` |
| Attempt closure decision (expiry + grace) | `attempt-reconciliation` | `http/src/payment-repository.ts` | `openreceive-server/.../reconciliation.rb` | `ReceiveOnlyNwcClient.GetInvoice` status mapping: Paid/Unpaid, and Expired only for a wallet-reported expiry; the grace-window cases are asserted NOT to yield Expired, because BTCPay owns invoice expiry |
| Exact money and fiat quoting | `fiat-to-msats.usd` | `core/src/money/`, `core/src/rates/` | `core.rb` (`Money`), `rates.rb` | excluded: BTCPay owns rates |
| LSC URI | `lsc-uri` | `node/src/lsc-uri.ts` | `openreceive-server/.../lsc_uri.rb` | `Swaps/LscUri.cs` |
| Swap address checksums | `swap-address` | `core/src/swap/address.ts` | `openreceive/lib/openreceive/swap_address.rb` | `Swaps/SwapAddress.cs` |
| FixedFloat status → state and reasons | `swap-state` | `node/src/swap/fixedfloat-orders.ts` (`normalizeFixedFloatStatus`) | `openreceive-server/.../swap/fixedfloat.rb` (`normalize_status`) | `Swaps/FixedFloatCompatibleProvider.cs` |
| Per-IP budget window column | `rate-limit-window` | `http/src/rate-limit.ts` | Rails `OpenReceivePayment` model | excluded: BTCPay owns budgets |
| HTTP wire bodies and statuses | `http-golden/*` | `http/src/handler.ts` | `openreceive-server/.../rack_app.rb` | excluded: BTCPay-shaped routes |
| Provider wizard routes | `provider-route.*` | `provider-data` | excluded: no wizard | excluded: no wizard |
| Shared vocabularies and numbers | generated from `spec/data/kernel-tables.json` | `core/src/generated/contracts.ts`, `node/src/generated/swap-tables.ts` | `openreceive/lib/openreceive/generated/tables.rb` | `Generated/OpenReceiveTables.cs` |

The exclusions are the ones written into `spec/test-vectors/coverage.json`; the table above is
the prose reading of that file. The C# column shipped on 2026-09-03: every file named exists
under `packages/dotnet/BTCPayServer.Plugins.OpenReceive/`, and the test project
`BTCPayServer.Plugins.OpenReceive.Tests/Vectors/` has one class per non-excluded family.

### Host glue, per engine

Never shared, never generated, and always the larger half of an engine:

- **JS**: the `openreceive_payments` repository and SQL/ORM adapters (`@openreceive/http`), the
  Express/Fastify/Next mounts, the CLI scaffold, the browser checkout and framework wrappers.
- **Ruby**: the Rails engine (controllers, ActiveRecord model, generators, reconcile job), the
  Rack app, configuration loading.
- **C#**: `ReceiveOnlyNwcClient` (`IExtendedLightningClient`) and its two listeners, the
  `ScanMemo`, the connection-string handler, the EF DbContext and migration for
  `openreceive_swaps`, `SwapService` / `SwapPoller` / the provider pool, the Razor views and
  the Vue checkout component, the UI, payer-API and Greenfield controllers, and the settings
  service. Plus the two test hosts: `OpenReceive.TestkitNwc` and `OpenReceive.FakeLsc`.

## Shared tables

`spec/data/kernel-tables.json` holds: the seven pay-in assets with labels and networks; the twelve
swap provider states with their UI phase and terminal flag; the attention, refund, and
availability reason enums; the NWC required-receive and spend method sets, the encryption mode
preference, the notification types, the page limit and the metadata byte cap; the attempt expiry
grace; and the retryable error codes. Error codes and payment statuses stay in
`spec/schemas/error.schema.json` and the OpenAPI document, which the generator already reads.

Engine code reads the generated rendering and adds behavior on top (lookups, matching, copy).
The JS state catalog, for instance, keeps its payer-facing labels in `node/src/swap/state.ts`
but takes the state list, phases, and terminal flags from the generated table, so a new state
cannot ship without copy and copy cannot name a state the spec lacks.

An attention reason marked `reserved: true` is vocabulary no `swap-state` case produces:
`provider_completed_without_wallet_settlement` is a time-based transition, not a status
mapping. The BTCPay plugin's `SwapPoller` is its first and only emitter (completed for 30
minutes with no wallet settlement); JS and Ruby still never emit it (`scope-lock.md`). Every
other reason must be produced by at least one `swap-state` case, which is how the table cannot
grow dead entries again.

## Coverage rule

`spec/test-vectors/coverage.json` lists each engine's test roots and its exclusions with a
reason. `npm run validate` walks every vector family and fails when an engine has neither a
consumer (a test naming `<family>.json` or `vector("<family>")`) nor an exclusion. An engine
whose roots do not exist yet is reported as absent and skipped, so its entry can be written
before its first test does. All three engines — `js`, `ruby`, `dotnet` — now have roots that
exist; the `dotnet` entry excludes `fiat-to-msats.usd`, `rate-limit-window`, `http-golden` and
`provider-route.*` with the reasons written in the file.

## Adding an engine

1. Add the engine to `spec/test-vectors/coverage.json` with its test roots and any exclusions,
   each with a one-line reason.
2. Add a rendering of `spec/data/kernel-tables.json` to `tools/codegen/generate-js-models.mjs`
   and register the output path; `npm run check:generated` now guards it.
3. Port the kernel rows in the table above, in the order the vectors dictate: URI and info,
   settlement, the wallet walk, the closure decision, then the swap rows if the engine has a
   swap rail. Each port reads its vector file directly and fails on drift.
4. Write the host glue.
5. Add the engine's test command to `package.json` and `docs/internal/test-command-map.md`, and a
   CI job; record the decision in `docs/internal/scope-lock.md` next to the Ruby paragraph.

The BTCPay plugin (`packages/dotnet`) is the first engine added through this checklist: its
command is `npm run test:dotnet`, its CI job is `dotnet-plugin`, and its decision paragraph
sits next to Ruby's in `scope-lock.md`.

## Known duplication without a shared source

The FixedFloat-compatible provider is the largest kernel module that exists three times by hand
(`node/src/swap/fixedfloat*.ts`, `openreceive-server/.../swap/fixedfloat.rb`, and
`packages/dotnet/.../Swaps/FixedFloatCompatibleProvider.cs`). The `swap-state` vector pins the
status mapping in all three, and the reason and asset vocabularies are generated, but the
mapping logic itself is still three implementations.

The recommended next step, not yet done: express the status mapping as an ordered decision
table in `spec/data` (match on status, emergency choice, emergency statuses, refund-tx
presence; produce state and reasons) and reduce each engine's normalizer to a short
interpreter of that table. The `swap-state` vector then tests the interpreter, and a provider
behavior change is one data edit plus a vector case instead of three code changes. Estimated
at one to two days across the three engines.
