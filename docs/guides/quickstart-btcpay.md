# BTCPay Server quickstart

Requires BTCPay Server ≥ 2.4.2.

The OpenReceive plugin makes a receive-only NWC wallet the Lightning node of a
BTCPay store. BTCPay mints every Lightning invoice in that wallet and records
payments through its own settlement machinery. Optionally, payers can pay a
BTCPay invoice with USDT, USDC, ETH or SOL through a Lightning Swap Connect
provider; the swap settles into the same wallet. The store's internal node is
never used.

This is not the Node or Rails library. There are no hooks, no
`openreceive_payments` table and no OpenReceive HTTP routes: BTCPay's
invoices, checkout, webhooks and Greenfield API are the host.

## 1. Prerequisites

- A BTCPay Server, version 2.4.2 or later, on any network (mainnet, testnet,
  signet, regtest). The wallet must be on the same network.
- A receive-only NWC code for the wallet you want to receive into
  ([get one here](https://openreceive.org/get_a_nwc_code_to_receive_payments)).
  The code must grant `make_invoice` and `list_transactions` and must not
  advertise any spend method. `lookup_invoice` is optional.
- Optionally, a Lightning Swap Connect (LSC) code from a
  [swap provider](https://openreceive.org/set_up_swap_provider), if payers
  should be able to pay with USDT, USDC, ETH or SOL.

## 2. Install the plugin

The plugin is not yet listed in the BTCPay plugin directory. Until it is,
install it by hand or through the Plugin Builder.

**Manual install.** Build the plugin, then copy the output directory into
BTCPay's plugin directory and restart BTCPay.

```sh
git clone --recurse-submodules https://github.com/OpenReceive/openreceive.git
cd openreceive
packages/dotnet/docker/build-plugin.sh   # builds inside the .NET 10 SDK image; no host .NET needed
```

The build lands in `packages/dotnet/docker/.state/plugins/BTCPayServer.Plugins.OpenReceive/`.
Copy that directory to `~/.btcpayserver/Plugins/BTCPayServer.Plugins.OpenReceive/`
(for the docker image, `/root/.btcpayserver/Plugins/` inside the container)
and restart BTCPay. With a local .NET 10 SDK, `dotnet build -c Release` in
`packages/dotnet/BTCPayServer.Plugins.OpenReceive` produces the same output
under `bin/Release/net10.0/`.

**Plugin Builder.** On [plugin-builder.btcpayserver.org](https://plugin-builder.btcpayserver.org)
create a build from this repository's https URL with project directory
`packages/dotnet/BTCPayServer.Plugins.OpenReceive`. The builder clones
submodules, so the pinned BTCPay source it compiles against comes along.

BTCPay migrates the plugin's one table (`openreceive_swaps`, schema
`BTCPayServer.Plugins.OpenReceive`) in its own Postgres at startup. Nothing
else is created.

## 3. Connect the wallet

Open the store, then **OpenReceive** in the store navigation (it is also
under Wallets, and the store dashboard shows a setup card until a wallet is
connected).

1. Paste the receive-only NWC code into **Receive-only NWC code**.
2. Click **Test connection**. The report lists the wallet's methods,
   encryption (`nip44_v2` preferred, `nip04` fallback), notifications,
   network, relay round trip and any spend methods found. A refused code
   says why: a missing receive method, unsupported encryption, a spend
   method advertised, a network mismatch, an unreachable relay, or no
   NIP-47 info event.
3. Click **Use as this store's Lightning node**. The plugin writes the
   connection string `type=openreceive;nwc=<NWC URI>` into the store's
   BTC-Lightning payment method through BTCPay's own validation path, and
   enables LNURL-pay the way BTCPay's Lightning settings page does. From
   then on the page shows the connection redacted with a **Run a health
   check** button that shows the probes in place (the wallet preflight among
   them); a collapsed **Change NWC receive code** disclosure holds the box
   for a new code and its **Switch to this wallet** button.

The setup page is the whole install. You never open BTCPay's Lightning node
screen, and the plugin never reads the internal node.

Saving fails closed if the wallet advertises a spend method such as
`pay_invoice`. Mint a receive-only code instead. If the wallet cannot, tick
**This wallet cannot mint a receive-only code and I accept the risk**, which
appears under the code field once a test has found a spend method; the
string then carries `;allow-spend=true`, and the plugin logs a warning on
every preflight.
The plugin still never sends: it calls no NIP-47 `pay_*` method whatever the
wallet grants.

BTCPay stores the connection string like any other Lightning credential: in
its database, visible to store owners and through Greenfield. Receive-only
is what bounds the damage of a leak.

## 4. Optional: turn on swaps

Swaps need step 3 first: they settle into the OpenReceive wallet, and a store
on any other Lightning backend sees no swap options.

1. Paste the LSC code into **Lightning Swap Connect code (primary)**. A
   backup code is used only while the primary is down.
2. Click **Test provider** to fetch the provider's catalog and see which
   assets it offers right now, with their limits.
3. Choose the assets to offer and click **Save swap settings**. A saved
   primary code is what turns swaps on; removing it turns them off. There is
   no separate switch (the Greenfield `swapsEnabled` field can still pause
   swaps while keeping the code).

Saving a code raises **Store → Checkout → Invoice expiration** to 60
minutes when it is shorter. A swap needs at least 45 minutes of invoice life:
the provider's deposit window plus its settlement time. Swap creation is
refused when an invoice has less than the provider's window left (30 minutes
by default), and after any partial Lightning payment on the invoice.

The LSC code is a bearer credential. It lives in the plugin's per-store
settings, server-side only; the provider's order token never reaches a
browser or a log, and the setup page never shows a saved code again: it
displays it redacted, an empty field keeps it, a pasted code replaces it, and
a checkbox removes it. [Lightning Swap Connect](lightning-swap-connect.md) is
the format.

A relay or provider on the local network (loopback, a private range, a
link-local address, a `.internal`/`.local`/`.lan` name or a bare single-label
host) can only be saved by a server admin. That is BTCPay's own rule for
Lightning connection strings, applied to the hosts BTCPay's check does not
see.

## 5. The doctor

**Run a health check** on the setup page (or **Health check** top right for
the same probes on their own page) runs read-only probes now: the Lightning
node is an
OpenReceive connection, the wallet passes preflight, the wallet pushes
`payment_received` notifications, when the last wallet scan ran, the swap
provider is reachable and which assets it offers, the invoice expiration
covers the provider window, and how many swaps need a human. Each failing
probe carries a fix link.

## What is unsupported, by design

- Every send-side BTCPay feature: Lightning payouts, pull-payment refunds
  over Lightning, the wallet's send tab and channel management. The client
  throws a clear "receive-only" error for each.
- Top-up (amountless) invoices. Every invoice needs an amount; a top-up
  invoice fails with a clear message.
- A bare `nostr+walletconnect://` string in BTCPay's Lightning node screen.
  That form belongs to the Nostr plugin, which claims it without the
  receive-only guard. Only `type=openreceive;nwc=…` is OpenReceive's.
- Node information (`GetInfo`) and outgoing payment history: the wallet is
  remote.

## Settlement

BTCPay's own `LightningListener` is the settlement authority. The plugin's
client answers `GetInvoice` from one per-connection scan of the wallet's
history (settled and unpaid views, pages of 20, a 24-hour window), refreshed
every 2–12 seconds while invoices are live; one walk serves every invoice
BTCPay asks about. A wallet that pushes `payment_received` notifications
settles invoices as they arrive; the scan is the safety net.

An unknown payment hash is reported as unpaid, never as missing or expired:
either answer would make BTCPay drop a live invoice from its watched set.
BTCPay's own invoice state machine owns expiry.

## Paying with a swap

The checkout shows one pill per offered asset ("USDT · Tron", "SOL · Solana",
…). Picking one creates a provider order aimed at the invoice's existing
Lightning BOLT11 and shows the deposit address, amount and a countdown; the
plugin polls the provider, and BTCPay's checkout flips to paid when the
wallet reports the Lightning payment.

A deposit that arrives short or late becomes `refund_required`, and the same
checkout screen shows a refund-address form (checksum-validated for the
asset's network). Re-opening the invoice's checkout page and re-picking the
asset re-serves the same order while the invoice is still payable. After the
BTCPay invoice expires, the swap row stays visible to the merchant on the
invoice page, with the provider order id, and the refund has to be arranged
with the provider directly.

Provider states, attention reasons and refund reasons are the shared
OpenReceive vocabulary. A swap reported `completed` by the provider whose
Lightning side has not settled within 30 minutes is flagged for attention
(`provider_completed_without_wallet_settlement`). A swap with no deposit 15
minutes after the provider's window closes is closed as expired. Provider
polling runs every 5 seconds, dropping to 30 seconds once the invoice's
Lightning side settled.

## Greenfield API

Every route takes a Greenfield API key with the store permission shown.

| Route | Permission | What it does |
| --- | --- | --- |
| `GET /api/v1/stores/{storeId}/openreceive/settings` | view store settings | Lightning node status, swap settings, invoice expiration, last preflight |
| `PUT /api/v1/stores/{storeId}/openreceive/settings` | modify store settings | `nwcUri`, `allowSpendCapableWallet`, `lscPrimary`, `lscBackup`, `swapsEnabled`, `enabledPayInAssets`; setting `nwcUri` runs the preflight and makes it the Lightning node |
| `POST /api/v1/stores/{storeId}/openreceive/wallet/test` | modify store settings | Runs the preflight for `nwcUri` (or the saved code) and returns the report |
| `GET /api/v1/stores/{storeId}/openreceive/swaps?limit=50` | view store settings | Recent swap rows for the store |
| `GET /api/v1/stores/{storeId}/openreceive/invoices/{invoiceId}/swaps` | view store settings | Swap rows for one invoice |

Swap rows never include the provider token. A refused update changes nothing
(every field is checked before anything is written) and answers with a
`code`: `wallet_refused` (the preflight said no, with its message),
`wallet_required`, `lsc_required`, `invalid_lsc_uri`, `invalid_pay_in_asset`
(an unknown asset name; an empty list offers every asset),
`endpoint_not_allowed` (a local-network relay or provider without server
admin rights), `nwc_required`, `invalid_nwc_uri`. `allowSpendCapableWallet`
on its own re-saves the store's current code with that override, through the
same preflight.

The payer's swap routes are anonymous and addressed by invoice id plus swap
id (the invoice id is the bearer, as for BTCPay's own checkout page; a repeat
create re-serves the live order without a provider call):
`POST /api/plugins/openreceive/swaps` `{invoiceId, payInAsset}`,
`GET /api/plugins/openreceive/swaps/{invoiceId}/{swapId}`, and
`POST /api/plugins/openreceive/swaps/{invoiceId}/{swapId}/refund`
`{refundAddress}`. The checkout component calls them; a custom checkout can
too.

## Troubleshooting

- **"Could not reach the wallet through its relay"** — the relay in the
  NWC code is down or unreachable from the BTCPay host. Check outbound
  `wss://` access and the relay URL; test again.
- **"No NIP-47 info event was found"** — the wallet service is offline, or
  the code names a relay the wallet does not publish to.
- **"advertises spend methods"** — the code can spend. Mint a receive-only
  code, or tick the override and accept the risk.
- **"The wallet is on mainnet but this BTCPay Server runs on regtest"** —
  networks must match. Connect a wallet on BTCPay's network.
- **Swaps are not offered on an invoice** — the store's Lightning node is
  not the OpenReceive connection, swaps are off, no LSC code is saved, the
  invoice has less than the provider window left, it received a partial
  payment, or it is a top-up invoice. The doctor names which.
- **Invoice expiration** — a swap-enabled store needs at least 45 minutes
  (60 recommended). An expiration above 24 hours is outside the wallet scan
  window and the doctor flags it.
- **Payments settle slowly** — the wallet pushes no `payment_received`
  notifications, so settlement waits for the periodic scan (2–12 s). The
  doctor shows the notification probe and the last scan time.

## Run the regtest stack

`packages/dotnet/docker/` is a complete regtest environment in Docker:
bitcoind, NBXplorer, Postgres, two LND nodes, a Nostr relay behind TLS, a
NIP-47 wallet service backed by the merchant LND, a fake FixedFloat-compatible
swap provider, and the official BTCPay 2.4.2 image with the plugin mounted.
Nothing but Docker is needed on the host.

```sh
git submodule update --init --depth 1 packages/dotnet/submodules/btcpayserver
packages/dotnet/docker/up.sh        # build the plugin, start and fund everything
packages/dotnet/docker/e2e.sh       # register, connect the wallet, pay an invoice, swap, refund
packages/dotnet/docker/test-e2e.sh  # the same legs as xunit, run inside the .NET SDK container
packages/dotnet/docker/browser-e2e.sh  # the Playwright suite in Chromium, inside the Playwright image
packages/dotnet/docker/down.sh      # stop; add --volumes to wipe chain and wallet data
```

`up.sh` prints the BTCPay URL (`http://127.0.0.1:14180`), and where to fetch
the testkit's NWC code and the fake provider's LSC URI. `e2e.sh` drives the
whole flow over HTTP: the Greenfield settings routes, an invoice paid from the
customer LND, an invoice paid through a scripted USDT swap, an underpaid swap
refunded to a checksum-validated address, and a spend-capable code refused
without the override. It ends with `E2E PASSED`.

`browser-e2e.sh` (or `npm run test:e2e:btcpay` with a local Chromium) drives
the same store through a real browser: the setup page's three buttons and the
capability report, the doctor, BTCPay's checkout paying a Lightning invoice,
the swap pills and the swap component through to BTCPay's "Invoice Paid"
screen with no reload, the refund form with a rejected checksum, and switching
back to the Lightning pill. The spec is `tests/e2e-btcpay/btcpay.spec.ts`.

## Next

- [BTCPay plugin reference](btcpay-reference.md) — every setting, route, state, log event and probe
- [Security](security.md) — why receive-only is the only wallet credential
- [Lightning Swap Connect](lightning-swap-connect.md) — what an LSC code is
- [Automated swaps](automated-swaps.md) — the provider states and what turning swaps on commits you to
