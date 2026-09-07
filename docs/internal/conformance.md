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

The NWC rows below implement [NIP-47 core](https://github.com/nostr-protocol/nips/blob/master/47.md)
plus two extensions, [NWC-05 Transaction History](https://github.com/nostr-wallet-connect/nwc/blob/main/05.md)
(`list_transactions`, the 20-row page) and [NWC-02 Notifications](https://github.com/nostr-wallet-connect/nwc/blob/main/02.md)
(`payment_received`, kinds 23196/23197). `spec/README.md` maps each document to the
vectors that pin it.

An engine is two layers. The **kernel** is the behavior the vectors pin; a new engine ports
every row below and proves it against the same files. The **host glue** is everything that
binds the kernel to one platform; it is written fresh per engine and is never shared or
generated. When someone asks "how much of a new language is real work", the answer is: the
kernel rows are bounded and mechanical, the glue is the project.

| Kernel module | Pinned by | JS | Ruby | C# (BTCPay plugin) | PHP (`packages/php/openreceive`) | Python (`packages/python/openreceive/src/openreceive`) |
| --- | --- | --- | --- | --- | --- | --- |
| NWC URI parse + redaction | `nwc-uri-parse` | `core/src/nwc/client.ts` | `openreceive/lib/openreceive/core.rb` (`Nwc`) | `Nwc/NwcUri.cs` | `src/Nwc/Uri.php` | `nwc/uri.py` |
| Wallet capability summary + receive-only preflight | `nwc-info` | `node/src/nwc/normalize.ts` | `openreceive-server/.../wallet_info.rb` | `Nwc/NwcInfo.cs`, `WalletPreflight.cs` | `src/Nwc/Info.php` | `nwc/info.py` |
| NIP-47 request building + reply normalization | `nwc-request-response`, `make-invoice-validation`, `amount-boundaries` | `node/src/nwc/normalize.ts` | `core.rb` (`Nwc`, `Money`) | `ReceiveOnlyNwcClient.cs` | `src/Nwc/Requests.php`, `src/Money/Money.php` | `nwc/requests.py`, `money.py` |
| Wallet error normalization | `error-normalization` | `node/src/nwc/errors.ts` | `core.rb` (`Nwc.normalize_wallet_error`) | `Nwc/NwcErrors.cs` | `src/Nwc/Errors.php` | `nwc/errors.py` |
| Settlement classification | `settlement-detection` | `core/src/settlement/` | `core.rb` (`Settlement`) | `Nwc/Settlement.cs` | `src/Settlement/Settlement.php` | `settlement.py` |
| Paged, deduped, truncation-safe wallet walk | `wallet-scan-truncation` | `core/src/payments.ts` | `service.rb` (`reconcile_payments`) + `core.rb` (`Payments`) | `Nwc/WalletScan.cs` | `src/Payments/WalletScan.php` | `payments/scan.py` |
| Attempt closure decision (expiry + grace) | `attempt-reconciliation` | `http/src/payment-repository.ts` | `openreceive-server/.../reconciliation.rb` | `ReceiveOnlyNwcClient.GetInvoice` status mapping: Paid/Unpaid, and Expired only for a wallet-reported expiry; the grace-window cases are asserted NOT to yield Expired, because BTCPay owns invoice expiry | `src/Payments/Reconciliation.php` | `payments/reconciliation.py` |
| Exact money and fiat quoting | `fiat-to-msats.usd` | `core/src/money/`, `core/src/rates/` | `core.rb` (`Money`), `rates.rb` | excluded: BTCPay owns rates | `src/Money/Money.php`, `src/Rates/` | `money.py`, `rates/` |
| LSC URI | `lsc-uri` | `node/src/lsc-uri.ts` | `openreceive-server/.../lsc_uri.rb` | `Swaps/LscUri.cs` | `src/Swap/LscUri.php` | `swap/lsc_uri.py` |
| Swap address checksums | `swap-address` | `core/src/swap/address.ts` | `openreceive/lib/openreceive/swap_address.rb` | `Swaps/SwapAddress.cs` | `src/Swap/SwapAddress.php` (+ `Keccak256.php`, `Base58.php`) | `swap/address.py` (+ `keccak.py`, `base58.py`) |
| FixedFloat status → state and reasons | `swap-state`; the mapping itself is data, `spec/data/swap-state-table.json`, rendered next to the kernel tables and interpreted by each engine | `node/src/swap/fixedfloat-orders.ts` (`normalizeFixedFloatStatus` over `node/src/generated/swap-state-table.ts`) | `openreceive-server/.../swap/fixedfloat.rb` (`normalize_status` over `Generated::SWAP_STATUS_ROWS`) | `Swaps/FixedFloatOrders.cs` (`NormalizeStatus` over `OpenReceiveTables.SwapStatusRows`) | `src/Swap/StateTable.php` (`normalizeStatus` over `Tables::SWAP_STATUS_ROWS`) | `swap/state.py` (`normalize_status` over `SWAP_STATUS_ROWS`) |
| Per-IP budget window column | `rate-limit-window` | `http/src/rate-limit.ts` | Rails `OpenReceivePayment` model | excluded: BTCPay owns budgets | `src/Server/RateLimit.php` + `SqlPaymentRepository` | `server/rate_limit.py` + `storage/sql/repository.py` |
| HTTP wire bodies and statuses | `http-golden/*` | `http/src/handler.ts` | `openreceive-server/.../rack_app.rb` | excluded: BTCPay-shaped routes | `src/Server/Psr15Handler.php` (+ `RequestHandler.php`) | `server/handler.py` |
| Provider wizard routes | `provider-route.*` | `provider-data` | excluded: no wizard | excluded: no wizard | excluded: no wizard | excluded: no wizard |
| Shared vocabularies and numbers | generated from `spec/data/kernel-tables.json` and `spec/data/swap-state-table.json` | `core/src/generated/contracts.ts`, `node/src/generated/swap-tables.ts`, `node/src/generated/swap-state-table.ts` | `openreceive/lib/openreceive/generated/tables.rb` | `Generated/OpenReceiveTables.cs` | `src/Generated/Tables.php` | `_generated/tables.py` |

The exclusions are the ones written into `spec/test-vectors/coverage.json`; the table above is
the prose reading of that file. The PHP and Python columns shipped on 2026-09-07 through the same
checklist: each has one vector test per non-excluded family (`packages/php/openreceive/tests/
Vectors/`, `packages/python/openreceive/tests/vectors/`), the `http-golden` files run against
the PSR-15 handler and the framework-free Python handler, and both engines' FixedFloat
normalizers are interpreters of the decision table, never hand-written mappings. The C# column shipped on 2026-09-03: every file named exists
under `packages/dotnet/BTCPayServer.Plugins.OpenReceive/`, and the test project
`BTCPayServer.Plugins.OpenReceive.Tests/Vectors/` has one class per non-excluded family.

### Host glue, per engine

Never shared, never generated, and always the larger half of an engine:

- **JS**: the `openreceive_payments` repository and SQL/ORM adapters (`@openreceive/http`), the
  Express/Fastify/Next mounts, the CLI scaffold, the browser checkout and framework wrappers.
- **Ruby**: the Rails engine (controllers, ActiveRecord model, generators, reconcile job), the
  Rack app, configuration loading.
- **PHP**: the `DatabaseConnection` seam (`PdoConnection` here, a `$wpdb` adapter in the
  WordPress plugin), `SqlPaymentRepository` + `MetaStore` + `PaymentsSchema` DDL per dialect,
  `Server\Engine` (the Rails `Configuration` twin), the PSR-15 mount, the
  `dsbaars/nostr-php-nwc` adapter plus the in-repo NWC-02 `NotificationListener`, the Laravel
  service provider / artisan commands (`packages/php/laravel`), and the `Testing\` fakes.
- **Python**: `SqlPaymentRepository` on SQLAlchemy Core and the Django ORM repository, the
  `OpenReceiveApp` composition, the in-repo NWC transport (`nwc/transport`: NIP-01/NIP-44/
  NIP-04 over a synchronous websocket), the Django app (models, shipped migrations, views,
  system checks, management commands), the FastAPI router + lifespan, the `openreceive` CLI,
  and the `openreceive.testing` fakes.
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
with no test source in its extensions under any of its roots yet is reported as absent and
skipped, so its entry can be written before its first test does — a shared root such as
`tools/conformance` existing for another engine does not make it present — and enforcement
starts with the first test file. Five engines — `js`, `ruby`, `dotnet`, `php`, `python` — have sources; the
`dotnet` entry excludes `fiat-to-msats.usd`, `rate-limit-window`, `http-golden` and
`provider-route.*` with the reasons written in the file. The `php` and `python` entries
(each excluding only `provider-route.crypto-usdt`) have had consumers since 2026-09-07.

## Adding an engine

1. Add the engine to `spec/test-vectors/coverage.json` with its test roots and any exclusions,
   each with a one-line reason.
2. Add a rendering of `spec/data/kernel-tables.json` to `tools/codegen/generate-js-models.mjs`
   and register the output path; `npm run check:generated` now guards it.
3. Port the kernel rows in the table above, in the order the vectors dictate: URI and info,
   settlement, the wallet walk, the closure decision, then the swap rows if the engine has a
   swap rail. Each port reads its vector file directly and fails on drift.
4. Write the host glue, including the engine's port of the fake wallet and fake swap
   provider with the fixtures in [`testkit-contract.md`](testkit-contract.md), so the shared
   E2E suite can drive the engine's demo through the `__testkit` control routes.
5. Add the engine's test command to `package.json` and `docs/internal/test-command-map.md`, and a
   CI job; record the decision in `docs/internal/scope-lock.md` next to the Ruby paragraph.

The BTCPay plugin (`packages/dotnet`) is the first engine added through this checklist: its
command is `npm run test:dotnet`, its CI job is `dotnet-plugin`, and its decision paragraph
sits next to Ruby's in `scope-lock.md`.

The PHP engine (`packages/php`, `npm run test:php`, CI job `php-engine`) and the Python engine
(`packages/python`, `npm run test:python`, CI job `python-engine`) followed the same five steps
on 2026-09-07; their `coverage.json` entries are enforced (15 families consumed, one excluded
each) and their decision paragraphs sit under the BTCPay one in `scope-lock.md`.

## The FixedFloat mapping is data (2026-09-06)

The FixedFloat-compatible status mapping — status, emergency block and refund-tx presence →
state plus attention/refund reasons — used to be the largest kernel module written three
times by hand. Since 2026-09-06 it is one decision table, `spec/data/swap-state-table.json`
(14 ordered status rows matched first-match-wins, plus the emergency-status → refund-reason
rows and the OVER/OVERPAID → MORE aliases), rendered by `npm run generate:models` next to the
kernel tables and interpreted by each engine's production normalizer:

| Engine | Rendering | Interpreter |
| --- | --- | --- |
| JS | `packages/js/node/src/generated/swap-state-table.ts` | `node/src/swap/fixedfloat-orders.ts` (`normalizeFixedFloatStatus`) |
| Ruby | `openreceive/lib/openreceive/generated/tables.rb` (`SWAP_STATUS_ROWS`, `SWAP_REFUND_REASON_ROWS`) | `openreceive-server/.../swap/fixedfloat.rb` (`normalize_status`) |
| C# | `Generated/OpenReceiveTables.cs` (`SwapStatusRows`, `SwapRefundReasonRows`) | `Swaps/FixedFloatOrders.cs` (`NormalizeStatus`) |
| PHP | `packages/php/openreceive/src/Generated/Tables.php` (`SWAP_STATUS_ROWS`, `SWAP_REFUND_REASON_ROWS`) | `src/Swap/StateTable.php` (`normalizeStatus`) |
| Python | `packages/python/openreceive/src/openreceive/_generated/tables.py` (`SWAP_STATUS_ROWS`, refund-reason rows) | `swap/state.py` (`normalize_status`) |

The `swap-state` vector still runs against each production interpreter, and `npm run
validate` additionally replays the vector through a reference interpreter of the JSON (and
checks its vocabularies against `kernel-tables.json`, that its last row is a catch-all, and
that every row is hit by at least one case), so a table edit that breaks a case fails before
any engine runs. A provider behavior change is now one data edit plus one vector case instead
of three code changes; the explanatory notes (overpay takes the full-refund path, LIMIT names
no reason, unrecognized is not an emergency) live once, in the JSON's `how_to_read` and row
`note` fields. The rest of the provider module — request signing, field extraction, the
persisted-order fallback — is still host-shaped code per engine, on purpose.
