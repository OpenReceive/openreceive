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

1. Confirm the BTCPay Server version is 2.4.4 or later (Server Settings →
   About, or `GET /api/v1/server/info`). The plugin declares that minimum and
   BTCPay refuses to load it below.
2. Check whether the plugin is installed (the Plugins menu — the plug icon in
   the top-right corner — under Installed Plugins, or the store navigation
   shows an "OpenReceive" entry; through Greenfield,
   `GET /api/v1/stores/{storeId}/openreceive/settings` answers 404 until it
   is). If not, install it from the BTCPay plugin directory (the same Plugins
   menu → Plugin Directory, search "openreceive", then Install and Restart
   now), as the quickstart says; do not invent an installer command. BTCPay
   installs plugins only from its UI. If you cannot use it, ask the user to:
   name those clicks, and wait until they say it is installed.
3. Check whether the store already has an OpenReceive connection:
   `GET /api/v1/stores/{storeId}/openreceive/settings` returns
   `lightningNodeIsOpenReceive` and `lscPrimaryConfigured`. A code that is
   already saved is not asked for again; if both are, skip to Verifying.

Otherwise your next action is a question to the user. A store without a
connection has no code anywhere on this machine. Do not search for one: do not
read other files, Docker containers, compose files beyond this deployment's,
or process environments, and never run `printenv`. Hunting for a code burns
the turn and can leak other secrets into the transcript.

The user never edits BTCPay's settings for you. They paste each code
into the chat; you save it (Step 1). Ask one question per message:

1. **First message — the NWC code, and nothing else.** Ask for it and walk them
   through getting it:

   > To receive payments I need a receive-only wallet code. In Rizful: open
   > the menu, tap NWC, choose Receive-only NWC code, and tap Copy
   > (https://openreceive.org/get_a_nwc_code_to_receive_payments). If you would
   > rather run your own wallet, Alby Hub works too: Connections → Add
   > Connection → Read Only. Paste the code here and I will save it in
   > BTCPay.

   If the plugin still needs installing, ask for that in the same message.
2. **When they paste it.** If it does not start with `nostr+walletconnect://`,
   ask them to copy the receive-only code again. Otherwise save it (Step 1),
   reply only that it is saved, then ask the next question. Never print, log
   or echo the code; report only whether it is set. Never paste a bare
   `nostr+walletconnect://` string into BTCPay's Lightning node screen — that
   form is claimed by the Nostr plugin, without the receive-only guard.
3. **Second message — swaps.** If the user asked for stablecoins, USDT, USDC,
   ETH, SOL, altcoins or "crypto" (as in "Bitcoin and stablecoin payments"),
   this message IS the walkthrough below: send it as it is, and do not ask yes
   or no first. Otherwise ask whether payers should also be able to pay with
   USDT, USDC, ETH or SOL, then give the walkthrough. The walkthrough:

   > Go to https://lightning-swap.com, sign in for API keys, create a key, and
   > copy the whole URI (https://openreceive.org/set_up_swap_provider). Paste
   > it here and I will save it — or say "Bitcoin only" and I will continue
   > without it.

   Mention FixedFloat only if they already use it.
4. **When they paste it.** If it does not start with
   `lightning+swapconnect://`, ask them to copy it again. Otherwise save it
   (Step 1); saving it turns swaps on.

The quickstart below shows the same steps in BTCPay's UI.

## Step 1 — save the codes through the Greenfield API

Use a Greenfield API key the user gives you (Account → API Keys) that can
modify the store's settings. A swap provider on a local network needs a server
admin's key. Save each code yourself, one request each, and never in a
command line:

1. Write the request body with your file-editing tool, not a shell command (no
   `echo`, `printf` or heredoc), to a new file outside the deployment
   directory, such as `/tmp/openreceive-settings.json`:
   `{"nwcUri": "<the NWC code>"}`. For the LSC code the body is
   `{"lscPrimary": "<the LSC code>"}`; saving it turns swaps on.
2. Send it, with your server's address, the key and the store id:
   `curl -fsS -X PUT -H "Authorization: token $BTCPAY_API_KEY" -H "Content-Type: application/json" --data @/tmp/openreceive-settings.json "$BTCPAY_URL/api/v1/stores/$BTCPAY_STORE_ID/openreceive/settings"`.
3. Delete the file (`rm /tmp/openreceive-settings.json`), whether the request
   passed or not.

The response never contains a code. `lightningNodeIsOpenReceive: true` means
the wallet is saved; `swapsEnabled` and `lscPrimaryConfigured` say the same
for swaps. A refusal answers 422 with a `code` and a `message`: a code that
can spend is refused on purpose, so ask the user for a receive-only code
instead of setting the override.

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
- Do not suggest rotating, revoking or replacing a code because it was pasted
  into this chat; that is the supported path.
- BTCPay's `LightningListener` is the settlement authority. Provider
  `completed` is not payment; only the wallet reporting the Lightning invoice
  settled is. Do not build anything that fulfils on a provider state.
- There is no merchant-initiated refund of a settled Lightning payment. A swap
  refund is a payer reclaiming a deposit that never converted, and only from
  the `refund_required` provider state.

## Verifying

Store → OpenReceive → **Run a health check** (the doctor page) runs every probe now: connection, preflight,
notifications, last scan, provider reachability, invoice expiration, swaps
needing attention. Without the UI, check through Greenfield instead:
`GET /api/v1/stores/{storeId}/openreceive/settings` shows the wallet and
swaps, `POST /api/v1/stores/{storeId}/openreceive/wallet/test` with `{}`
runs the wallet preflight again, and a test invoice
(`POST /api/v1/stores/{storeId}/invoices` with an amount) must list a
`BTC-LN` payment method whose `destination` is a BOLT11. On a regtest machine, `packages/dotnet/docker/up.sh` then
`e2e.sh` in the OpenReceive repository proves the whole path end to end, and
that is the only situation where cloning the repository is the right move.

Setup ends when the health check, or those Greenfield checks, are clean. Say "Setup is finished" in one
message. Do not offer more work or end the message on a question.

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

- https://openreceive.org/guides/payment-safety-upgrade.md — coordinated upgrades and reviewed repair of existing attempts
