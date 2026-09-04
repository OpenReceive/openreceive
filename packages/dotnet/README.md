# OpenReceive .NET workspace

The BTCPay Server plugin and everything needed to build, test and prove it.
This is OpenReceive's third settlement engine: it ports the kernel modules
against the shared vectors in `spec/test-vectors/` and writes its host glue
against BTCPay Server 2.4.2. The merchant-facing guide is
[docs/guides/quickstart-btcpay.md](../../docs/guides/quickstart-btcpay.md).

## Layout

| Path | What it is |
| --- | --- |
| `BTCPayServer.Plugins.OpenReceive/` | The plugin. `Nwc/` is the receive-only NWC Lightning backend (`ReceiveOnlyNwcClient`, `ScanMemo`, listeners, preflight, URI parsing). `Swaps/` is the swap rail (LSC URI, FixedFloat-compatible provider, `SwapService`, `SwapPoller`). `Data/` is the EF DbContext and the hand-written migration for `openreceive_swaps`. `Settings/` is the per-store settings service. `Controllers/` and `Views/` are the setup page, the doctor, the checkout extensions and the two APIs. `Resources/js/` is the Vue 2 checkout component. `Generated/OpenReceiveTables.cs` is rendered from `spec/data/kernel-tables.json` by `npm run generate:models` — never edit it by hand. |
| `BTCPayServer.Plugins.OpenReceive.Tests/` | xunit v3. `Vectors/` has one class per vector family (each names its `<family>.json`, which is how `spec/test-vectors/coverage.json` counts it). `Nwc/`, `Swaps/` and `Fakes/` are kernel tests against the in-process testkit and fake provider. Runs in seconds, no Docker. |
| `OpenReceive.TestkitNwc/` | A NIP-47 wallet service for end-to-end tests (its own request loop over NNostr's client: NIP-44 v2 and NIP-04 per request, notifications in both kinds). In-memory invoices by default, or backed by an LND node through `BTCPayServer.Lightning`. Publishes the info event, mints one receive-only connection, pushes `payment_received`, and exposes an HTTP control API (`/health`, `/uri`, `/settle/{hash}` on the memory backend, `/invoices`). |
| `OpenReceive.FakeLsc/` | A fake FixedFloat-compatible swap provider: `/api/v2/ccies`, `/price`, `/create`, `/order`, `/emergency` with HMAC verification, plus `/__testkit/` control endpoints to script order lifecycles, force `refund_required` or attention, fail creates and burst 429s. On `completed` it pays the order's BOLT11 from a configured Lightning node. |
| `docker/` | The regtest end-to-end stack (below). |
| `submodules/btcpayserver/` | BTCPay Server source, pinned to `v2.4.2`, shallow. Only needed to compile the plugin; JS and Ruby contributors never initialize it. |
| `Directory.Build.props`, `global.json`, `*.slnx` | Shared build settings (`BtcPayServerRoot`), the .NET 10 SDK pin, and the solution. |

## Build

```sh
git submodule update --init --depth 1 packages/dotnet/submodules/btcpayserver
cd packages/dotnet
dotnet build BTCPayServer.Plugins.OpenReceive.slnx      # first build compiles BTCPay Server: minutes, then incremental
```

Needs the .NET 10 SDK (`global.json` pins 10.0.400, rolling forward within the
feature band). Set `BTCPAY_SERVER_ROOT` to an existing BTCPay checkout to skip
the submodule; `Directory.Build.props` reads it. The plugin references
`BTCPayServer.csproj` with `Private=false`, so the host's DLLs never land in
the output; `NNostr.Client` 0.0.55 does (NIP-44 v2 negotiation).

`packages/dotnet/docker/build-plugin.sh` builds the same thing inside the
`mcr.microsoft.com/dotnet/sdk:10.0` image with separate `obj-docker/` and
`bin-docker/` trees, so no host SDK is needed and a container build never
shares intermediates with a host build.

## Test

```sh
npm run test:dotnet                                      # from the repo root: the unit suite
npm run test:dotnet -- --filter "FullyQualifiedName~Vectors"
dotnet test packages/dotnet/BTCPayServer.Plugins.OpenReceive.Tests
```

`tools/dotnet/test.mjs` prints a clear `SKIPPED` line, never a silent pass,
when there is no .NET 10 SDK on `PATH` or the submodule is not initialized.
CI runs the same suite in its own `dotnet-plugin` job so the JS gate stays
fast. `npm run validate` checks that every vector family has a consumer or a
written exclusion in the `dotnet` entry of `spec/test-vectors/coverage.json`.

## The regtest stack

`docker/` is a complete environment in Docker Compose (project
`openreceive-btcpay`): bitcoind, NBXplorer, Postgres, `merchant_lnd` (the
remote wallet behind the testkit NWC service), `customer_lnd` (the payer and
the fake provider's payout node), a `nostr-rs-relay` behind an nginx TLS
terminator (NWC URIs must be `wss://`), `testkit-nwc`, a second
`testkit-nwc-spend` that advertises `pay_invoice`, `fake-lsc` over https, and
the official `btcpayserver/btcpayserver:2.4.2` image with the built plugin
bind-mounted into its plugin directory and the stack's CA trusted.

```sh
docker/up.sh              # build the plugin and the testkit images, start, fund, restart BTCPay
docker/e2e.sh             # the end-to-end proof, over HTTP only; ends with E2E PASSED
docker/test-e2e.sh        # OpenReceive.IntegrationTests (xunit, pure HTTP) inside the .NET SDK image
docker/browser-e2e.sh     # tests/e2e-btcpay (Playwright, Chromium) inside the Playwright image; --host uses local browsers
docker/down.sh            # stop; --volumes wipes chain, wallets, relay and BTCPay data
docker/up.sh --no-build   # restart with what is already built
```

`regtest-fund.sh` (run by `up.sh`, idempotent) mines, funds both LND nodes and
opens a customer → merchant channel. BTCPay listens on
`http://127.0.0.1:14180`; the testkit's control API is on `127.0.0.1:17790`
(`/uri` hands out the NWC code), the spend-capable one on `17791`, the fake
provider on `https://127.0.0.1:17788` (`/__testkit/lsc-uri`). `TESTKIT_NWC_EXTRA_ARGS`
passes flags such as `--encryption nip04`, `--no-notifications` (forces the
poll listener) or `--drop-offset` to the wallet service; `docker/pay.sh <bolt11>`
pays an invoice from `customer_lnd`. `docker/.state/` holds the built plugin and the e2e's store id; it is
ignored by git.

`e2e.sh` covers: first-user registration, an API key, a store, the wallet
preflight and settings through the plugin's Greenfield routes, an invoice paid
from `customer_lnd` and recorded `Settled`, swaps enabled with the fake
provider, an invoice paid through a scripted `USDT_TRON` swap (the row is
stamped `wallet_settled`), an underpaid swap refunded to a checksum-validated
address (a bad checksum is refused first), and a spend-capable code refused
without the override, both through the plugin API and through BTCPay's own
`PUT payment-methods/BTC-LN`.

`test-e2e.sh` runs `OpenReceive.IntegrationTests` (four xunit legs over HTTP,
skipped unless `OPENRECEIVE_E2E_BTCPAY_URL` is set). `browser-e2e.sh` runs
`tests/e2e-btcpay` in Chromium: the setup page, the doctor, BTCPay's checkout
paying a Lightning invoice, the swap component through to "Invoice Paid" with
no reload, the refund form, and the pill switch back to Lightning. Both reuse
the API key `e2e.sh` saved in `docker/.state/e2e-store`, because BTCPay closes
public registration after the first admin.

## Contracts the plugin keeps

- Connection string `type=openreceive;nwc=<NWC URI>[;allow-spend=true]`;
  bare `nostr+walletconnect://` and `type=nwc;key=…` are never claimed.
- Required wallet methods are exactly the kernel's `make_invoice` +
  `list_transactions`; `lookup_invoice` is an optional fast path. Encryption
  `nip44_v2` preferred, `nip04` fallback. Any spend method fails the
  preflight closed unless the override is set; the client never calls
  `pay_*` regardless.
- `GetInvoice` is served from one per-connection `ScanMemo` (24 h window,
  settled + unpaid views, pages of `OpenReceiveTables.TransactionPageLimit`,
  deduped, truncation-safe). It never returns null or `Expired` for a hash
  the wallet did not itself mark expired or failed.
- Settlement is BTCPay's `LightningListener`; the plugin records nothing
  about Lightning payments itself. Swaps target the invoice's existing
  BOLT11 and live in `openreceive_swaps`; the provider token is server-only.
- Vocabularies (assets, swap states, reasons, method sets, limits) come from
  `Generated/OpenReceiveTables.cs`. `npm run check:generated` fails when it
  is stale.
- The plugin `Version` in the csproj is stamped by `npm run release:prepare`
  in lockstep with the workspace; `npm run check:release` verifies it.
- The relay transport does its own request, fetch and subscribe over NNostr's
  client and CLOSES every subscription it opens. NNostr 0.0.55's own
  `SendNIP47Request` and `FetchEvents` never do, and relays cap concurrent
  subscriptions per socket (nostr-rs-relay: 20), after which every call hangs.

The design record is `docs/internal/conformance.md` (kernel boundary),
`docs/internal/scope-lock.md` (the third-engine decision) and
`docs/internal/btcpay-e2e.md` (the manual checklist).
