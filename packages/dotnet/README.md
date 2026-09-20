# OpenReceive .NET workspace

The BTCPay Server plugin and everything needed to build, test and prove it.
This is the .NET settlement engine: it implements the shared kernel modules
against the shared vectors in `spec/test-vectors/` and writes its host glue
against BTCPay Server 2.4.4. The merchant-facing guide is
[docs/guides/quickstart-btcpay.md](../../docs/guides/quickstart-btcpay.md).

OpenReceive supports optional swaps from **USDT, USDC, SOL, and ETH** through
a configured swap provider. The provider converts the payment to **BTC over
Lightning**, which settles into the merchant's connected wallet. Available
assets and networks depend on the provider; swaps are optional.

## Layout

| Path | What it is |
| --- | --- |
| `BTCPayServer.Plugins.OpenReceive/` | The plugin. `Nwc/` is the receive-only NWC Lightning backend (`ReceiveOnlyNwcClient`, `ScanMemo`, listeners, preflight, URI parsing). `Swaps/` is the swap rail (LSC URI, FixedFloat-compatible provider, `SwapService`, `SwapPoller`). `Data/` is the EF DbContext and the hand-written migration for `openreceive_swaps`. `Settings/` is the per-store settings service. `Controllers/` and `Views/` are the setup page, the doctor, the checkout extensions and the two APIs. `Resources/js/` is the Vue 2 checkout component. `Generated/OpenReceiveTables.cs` is rendered from `spec/data/kernel-tables.json` by `npm run generate:models` — never edit it by hand. |
| `BTCPayServer.Plugins.OpenReceive.Tests/` | xunit v3. `Vectors/` has one class per vector family (each names its `<family>.json`, which is how `spec/test-vectors/coverage.json` counts it). `Nwc/`, `Swaps/` and `Fakes/` are kernel tests against the in-process testkit and fake provider. Runs in the SDK container without the regtest stack. |
| `OpenReceive.TestkitNwc/` | A NIP-47 wallet service for end-to-end tests (its own request loop over NNostr's client: NIP-44 v2 and NIP-04 per request, notifications in both kinds). In-memory invoices by default, or backed by an LND node through `BTCPayServer.Lightning`. Publishes the info event, mints one receive-only connection, pushes `payment_received`, and exposes an HTTP control API (`/health`, `/uri`, `/settle/{hash}` on the memory backend, `/invoices`). |
| `OpenReceive.FakeLsc/` | A fake FixedFloat-compatible swap provider: `/api/v2/ccies`, `/price`, `/create`, `/order`, `/emergency` with HMAC verification, plus `/__testkit/` control endpoints to script order lifecycles, force `refund_required` or attention, fail creates and burst 429s. On `completed` it pays the order's BOLT11 from a configured Lightning node. |
| `docker/` | The regtest end-to-end stack (below). |
| `submodules/btcpayserver/` | BTCPay Server source, pinned to `v2.4.4`, shallow. Required for .NET builds/tests and the full `npm run test:ci` gate; focused JS and Ruby suites do not need it. |
| `Directory.Build.props`, `global.json`, `*.slnx` | Shared build settings (`BtcPayServerRoot`), the .NET 10 SDK pin, and the solution. |

## Build

```sh
git submodule update --init --depth 1 packages/dotnet/submodules/btcpayserver
bash packages/dotnet/docker/build-plugin.sh
```

Start Docker Desktop first; a native .NET SDK is optional. The container SDK
must satisfy `global.json` (10.0.400 or a later .NET 10 feature band). The plugin references
`BTCPayServer.csproj` with `Private=false`, so the host's DLLs never land in
the output; `NNostr.Client` 0.0.55 does (NIP-44 v2 negotiation).

`packages/dotnet/docker/build-plugin.sh` builds the same thing inside the
`mcr.microsoft.com/dotnet/sdk:10.0` image with separate `obj-docker/` and
`bin-docker/` trees, so no host SDK is needed and a container build never
shares intermediates with a host build.

## Test

```sh
npm run test:dotnet                                      # Docker: solution build + unit suite
npm run test:dotnet -- --filter "FullyQualifiedName~Vectors"
bash packages/dotnet/docker/test-unit.sh                 # same runner, no Node needed
npm run test:e2e:btcpay:smoke                            # isolated Docker stack + Chromium
npm run test:btcpay:latest                              # latest upstream source + runtime compatibility
```

The runner builds the entire solution, then runs the kernel/vector unit suite
inside the .NET SDK container. It requires Docker and the BTCPay submodule;
missing prerequisites and failed builds/tests exit unsuccessfully. It does not
inspect the Mac's SDK or start BTCPay, wallets, databases, or the regtest stack.
Set `BTCPAY_SERVER_ROOT` to use another local BTCPay checkout; the test runner
mounts it at the expected path inside the container. `SDK_IMAGE` and
`NUGET_VOLUME` share the defaults in `docker/lib.sh` with the existing build/E2E
scripts. Downloads persist in the `btcpay-plugin-nuget` Docker volume; separate
`obj-docker/` and `bin-docker/` directories preserve incremental builds without
mixing host and container output. The first build can take several minutes.

CI uses this same Docker runner in its own `dotnet-plugin` job and caches the
NuGet directory between runs. Native development remains possible with a
compatible SDK: run `dotnet build BTCPayServer.Plugins.OpenReceive.slnx` and
`dotnet test BTCPayServer.Plugins.OpenReceive.Tests` from `packages/dotnet`.
`npm run validate` checks that every vector family has a consumer or a
written exclusion in the `dotnet` entry of `spec/test-vectors/coverage.json`.

The same CI job also runs `test:e2e:btcpay:smoke` on every pull request and
push to master. It builds the plugin, starts the official pinned BTCPay image
with PostgreSQL and a generated NWC test connection to LND over a TLS Nostr relay,
and drives the setup page in Chromium: preflight, save, reload, then open a
BTC checkout invoice. It needs `npm ci`, Docker Compose 2.24.4 or later, and
the BTCPay submodule. The runner publishes no host ports, creates its own
administrator, and removes its containers and disposable volumes on exit.
It reuses the NuGet cache and the locked Playwright version. Setup traces are
disabled because the form contains wallet credentials. Full payment, swap,
and refund browser scenarios remain available through `browser-e2e.sh`.

### Automatic upstream compatibility checks

Every pull request, push to `master`, and `btcpay-v*` plugin release tag runs
**BTCPay Upstream Compatibility**.
Every general `v*` release tag also runs that workflow as
part of **Release Dry Run**, in parallel with the other release checks. It also
runs weekly and can be started from GitHub Actions with **Run workflow**.
`npm run test:btcpay:latest` runs the same check locally. The normal npm publisher
runs it when it cannot reuse successful CI and Release Dry Run results for the
release commit; the explicit `--skip-tests` override still skips release tests.

The check resolves GitHub's latest stable BTCPay release on every run, fetches
that tag's source, and pulls the matching official Docker image. It records the
source commit and image digest in the Actions summary and locally in
`.release/btcpay-compatibility/latest.json`. A lookup, download, compilation,
unit-test or browser failure fails the check; it never falls back to an older
BTCPay version. Prereleases and development branches are excluded.

It builds and unit-tests against the latest source, then runs the browser
preflight/save/reload/checkout smoke on that server. If our pinned source differs,
it also builds against the pin and runs that binary on the latest server. This
second test catches binary incompatibilities that rebuilding against the latest
source could hide. When the commits match, one runtime test covers both cases.
Separate temporary build directories keep the normal plugin output intact; the
submodule pin and plugin version are not changed. An incompatible upstream release
requires a source fix and another successful run before releasing the plugin.

## Manual browser demo with your wallet

Start Docker Desktop, configure the repository-root `.env` (see `.env.example`),
and run:

```sh
npm run demo btcpayserver
```

Every start resolves GitHub’s latest stable BTCPay release and pulls its official
Docker image, including `--published`, `--testkit`, and `--no-build` starts. A failed
lookup or pull stops startup; an old `BTCPAY_IMAGE` in `.env` does not override this.
`--stop` works offline. The plugin source stays pinned so testing can expose binary
incompatibilities with a newer server.

The command initializes a missing BTCPay submodule, builds the plugin in Docker,
and starts BTCPay plus Postgres at **http://127.0.0.1:14180**. It creates a local
administrator and an **OpenReceive demo** store, validates your receive-only
`NWC_URI`, and saves it as the store's Lightning backend. `LSC_URI_PRIMARY` enables
swaps; `LSC_URI_BACKUP` configures the fallback provider. Both are optional.
Credentials go directly from the launcher to BTCPay's server API. The command
prints the local dummy login: **`demo@openreceive.test` / `OpenReceive-demo-123!`**.
The ignored `docker/.state/live/login.json` holds this login and the demo API key.

This is a **mainnet** Lightning demo using your real wallet and providers. Create
an invoice in BTCPay and open its checkout to test a Lightning payment or swap.
Optional swaps accept USDT, USDC, SOL and ETH through the configured provider,
which converts them to BTC over Lightning in your connected wallet; available
assets and networks depend on the provider. Starting the demo configures the store;
payments and swaps are initiated manually in the browser.

The demo does not run a Bitcoin node or NBXplorer. BTCPay may show an explorer
connection warning; on-chain BTC checkout is unavailable in this Lightning setup.

```sh
npm run demo btcpayserver -- --stop       # stop; preserve accounts, store and invoices
npm run demo btcpayserver -- --no-build   # reuse the plugin build and reapply .env
```

### Test the published plugin

To test the same package distributed by BTCPay's Plugin Directory:

```sh
npm run demo btcpayserver -- --published
```

This downloads the latest stable OpenReceive version compatible with the demo's
BTCPay image, verifies the directory's SHA256 checksum, and queues BTCPay's native
plugin installer. It skips the local plugin build and submodule checkout. The
startup output names the downloaded version and build ID; **Installed Plugins**
in BTCPay shows the installed version.

The URL, login (`demo@openreceive.test` / `OpenReceive-demo-123!`), store, invoices,
and root `.env` wallet/provider settings are the same as in source mode. You can
switch modes by rerunning the command; `--published` fetches the current directory
package each time. A failed lookup or checksum check stops startup.

Published files live in `docker/.state/published-plugins`, separate from the local
build; `download.json` records the version, build, source commit, URL and checksum.
Use `npm run demo btcpayserver -- --stop` to stop either mode. Run
`npm run demo btcpayserver` to switch back to your local source. `--published`
cannot be combined with `--testkit` or `--no-build`.

Rerunning the command reuses the same store and applies the current `.env`.
Removing `LSC_URI_PRIMARY` disables swaps and clears the saved provider setting.
Exported environment variables take precedence over `.env`, as in the other demos.
The live and testkit stacks use separate Docker volumes but share port 14180;
stop one before starting the other. Starting one while the other holds the port
stops immediately and prints the command that stops the other. CI continues to
use generated test credentials.

## The regtest stack

For funded local test wallets and a fake swap provider, without `.env`:

```sh
npm run demo btcpayserver -- --testkit
npm run demo btcpayserver -- --testkit --stop
```

Register an administrator on the first visit. Startup prints commands to retrieve
the generated test-wallet and provider settings. This mode funds regtest wallets
and runs the full stack below. Add `--no-build` to reuse its plugin build.

`docker/` is a complete environment in Docker Compose (project
`openreceive-btcpay`): bitcoind, NBXplorer, Postgres, `merchant_lnd` (the
remote wallet behind the testkit NWC service), `customer_lnd` (the payer and
the fake provider's payout node), a `nostr-rs-relay` behind an nginx TLS
terminator (NWC URIs must be `wss://`), `testkit-nwc`, a second
`testkit-nwc-spend` that advertises `pay_invoice`, `fake-lsc` over https, and
the latest stable official `btcpayserver/btcpayserver` image with the built plugin
bind-mounted into its plugin directory and the stack's CA trusted.

```sh
docker/up.sh              # build the plugin and the testkit images, start, fund, restart BTCPay
docker/e2e.sh             # the end-to-end proof, over HTTP only; ends with E2E PASSED
docker/restart-e2e.sh     # an invoice paid while BTCPay is DOWN is Settled after the restart; --failed-scan, --manual
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

`restart-e2e.sh` (after one `e2e.sh` run, which creates the store it reuses)
makes an invoice, stops the BTCPay container, pays the invoice from
`customer_lnd`, starts BTCPay and waits for `Settled`. `--failed-scan` also
stops the relay before BTCPay starts, so the first wallet scans after the
restart fail: the invoice must still read `New` after 25 seconds, and settle
once the relay is back (BTCPay retries its Lightning connection every minute).
`--manual` pauses before each step and prints the command that performs it,
for an operator who wants to pay from another wallet or watch the BTCPay UI.
If the stack has been down for more than a day LND never reports
`synced_to_chain`; mine one block and rerun `up.sh --no-build`.

`test-e2e.sh` runs `OpenReceive.IntegrationTests` (xunit legs over HTTP,
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
- `GetInvoice` is served from one per-connection `ScanMemo` that watches the
  hashes BTCPay monitors: one targeted `list_transactions` walk from the
  oldest watched pending invoice (settled view, then the unpaid view for what
  is still missing; pages of `OpenReceiveTables.TransactionPageLimit`;
  stops once every watched hash is seen). A hash a truncated walk cannot
  reach falls back to `lookup_invoice` when granted and otherwise stays
  pending and watched. It never returns null or `Expired` for a hash the
  wallet did not itself mark expired or failed.
- Settlement is BTCPay's `LightningListener`; the plugin records nothing
  about Lightning payments itself. Swaps target the invoice's existing
  BOLT11 and live in `openreceive_swaps`; the provider token is server-only.
- Vocabularies (assets, swap states, reasons, method sets, limits) come from
  `Generated/OpenReceiveTables.cs`. `npm run check:generated` fails when it
  is stale.
- The plugin `Version` in the csproj and its publication are independent of
  npm/gem releases. Publishing it requires an explicit BTCPay release.
- The relay transport does its own request, fetch and subscribe over NNostr's
  client and CLOSES every subscription it opens. NNostr 0.0.55's own
  `SendNIP47Request` and `FetchEvents` never do, and relays cap concurrent
  subscriptions per socket (nostr-rs-relay: 20), after which every call hangs.

The design record is `docs/internal/conformance.md` (kernel boundary),
`docs/internal/scope-lock.md` (the third-engine decision) and
`docs/internal/btcpay-e2e.md` (the manual checklist).
