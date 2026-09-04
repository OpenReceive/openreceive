# OpenReceive agent directions (BTCPay Server)

Connect a BTCPay Server store to a receive-only NWC wallet with the OpenReceive
plugin, and optionally let payers pay BTCPay invoices with USDT, USDC, ETH or
SOL. You do not need a copy of the OpenReceive source, and there is no
application code to write: the plugin is configured through BTCPay's store UI
or its Greenfield API, and the quickstart is appended to this file in full.

This is the BTCPay plugin, not the Node or Rails library. Do not install
`@openreceive/*` packages or the `openreceive-rails` gem into a BTCPay
deployment, do not add `openreceive_payments` tables, and do not mount
OpenReceive HTTP routes. BTCPay's invoices, checkout, webhooks and Greenfield
API are the host; the plugin only supplies the Lightning backend and the swap
rail.

## What the plugin is

A BTCPay Server plugin (`BTCPayServer.Plugins.OpenReceive`) that registers a
Lightning connection-string handler for `type=openreceive;nwc=<NWC URI>`.
Saving that string makes the NWC wallet the store's Lightning node: BTCPay
mints every Lightning invoice in that wallet and its own `LightningListener`
records the payments. The plugin never calls a NIP-47 `pay_*` method, so
every send-side BTCPay feature (Lightning payouts, pull-payment refunds over
Lightning, the send tab) is unavailable by design.

The one required credential is a receive-only NWC code. A Lightning Swap
Connect (LSC) code optionally adds server-side swaps: a provider order aimed at
the invoice's existing BOLT11, tracked in the plugin's own table, with the
refund path on the same checkout screen.

## Step 0 — check the deployment before you change anything

1. Confirm the BTCPay Server version is 2.4.2 or later (Server Settings →
   About, or `GET /api/v1/server/info`). The plugin declares that minimum and
   BTCPay refuses to load it below.
2. Check whether the plugin is installed (Server Settings → Plugins, or the
   store navigation shows an "OpenReceive" entry). If not, install it per the
   quickstart. It is not yet listed in the BTCPay plugin directory; do not
   invent an installer command.
3. Check whether the store already has an OpenReceive connection:
   `GET /api/v1/stores/{storeId}/openreceive/settings` returns
   `lightningNodeIsOpenReceive`. If true, the wallet step is done — go to
   swaps only if the user wants them.
4. If no receive-only NWC code is available, stop and tell the user exactly
   what to create:

   > OpenReceive cannot mint an invoice without a receive-only NWC code. Get
   > one at https://openreceive.org/get_a_nwc_code_to_receive_payments and
   > paste it into Store → OpenReceive → Test connection, or hand it to me and
   > I will set it through the Greenfield API.

   Never print, log or echo the code; report only whether it is set. Never
   paste a bare `nostr+walletconnect://` string into BTCPay's Lightning node
   screen — that form is claimed by the Nostr plugin, without the receive-only
   guard.
5. If the user wants altcoin payments, ask for an LSC code from
   https://openreceive.org/set_up_swap_provider. Do not wait for it: the
   wallet works without it, and swaps switch on later with one settings change.

Only then start the quickstart.

## Non-negotiables

- The connection string is `type=openreceive;nwc=<NWC URI>[;allow-spend=true]`
  and nothing else. Set it through the setup page or
  `PUT /api/v1/stores/{storeId}/openreceive/settings` with `nwcUri`, never by
  editing BTCPay's Lightning node screen by hand.
- Receive-only is required. A code that advertises `pay_invoice` or another
  spend method is refused on save. The override (`allowSpendCapableWallet`,
  the checkbox on the setup page) is the user's explicit choice; never tick it
  to make a save succeed.
- The wallet's network must match BTCPay's. A mismatch is a refusal, not a
  warning.
- The wallet must grant `make_invoice` and `list_transactions`.
  `lookup_invoice` is optional; do not ask the user for a code that grants it.
- Swaps require the store's Lightning node to be the OpenReceive connection.
  Enabling swaps on a store using the internal node is refused
  (`wallet_required`).
- Swaps set the store's invoice expiration to 60 minutes when it is shorter,
  and the plugin refuses to create a swap on an invoice with less than the
  provider's window left. Do not lower the expiration below 45 minutes on a
  swap-enabled store.
- Top-up (amountless) invoices are unsupported on this backend. Do not
  configure a point of sale or payment link that relies on them with this
  wallet.
- Secrets stay server-side. The NWC code and LSC code live in BTCPay's
  database like every other BTCPay credential; never copy them into
  screenshots, tickets, browser code or logs. The provider's order token never
  leaves the server.
- BTCPay's `LightningListener` is the settlement authority. Provider
  `completed` is not payment; only the wallet reporting the Lightning invoice
  settled is. Do not build anything that fulfils on a provider state.
- There is no merchant-initiated refund of a settled Lightning payment. A swap
  refund is a payer reclaiming a deposit that never converted, and only from
  the `refund_required` provider state.

## Verifying

Store → OpenReceive → **Run a health check** (the doctor page) runs every probe now: connection, preflight,
notifications, last scan, provider reachability, invoice expiration, swaps
needing attention. On a regtest machine, `packages/dotnet/docker/up.sh` then
`e2e.sh` in the OpenReceive repository proves the whole path end to end, and
that is the only situation where cloning the repository is the right move.

## More documentation

Fetch one when the moment comes. Each is raw markdown, so a plain GET is
enough; drop the `.md` for the same page a person would read.

- https://openreceive.org/guides/btcpay-reference.md — every setting, route, swap state, doctor probe and log event of the plugin
- https://openreceive.org/guides/security.md — why receive-only is the only wallet credential
- https://openreceive.org/guides/lightning-swap-connect.md — what an LSC code actually is
- https://openreceive.org/guides/automated-swaps.md — provider states, and what turning swaps on commits a merchant to
- https://openreceive.org/guides/swap-refunds.md — the refund states; the route back is BTCPay's own invoice checkout page here
- https://openreceive.org/guides.md — the index, if what you need is not above

Questions, or a problem with the plugin itself:
https://openreceive.org/contact
