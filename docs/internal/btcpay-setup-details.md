# BTCPay plugin setup details

The long form of the [BTCPay quickstart](../guides/quickstart-btcpay.md):
what each control on the setup page does, what saving checks, and how a swap
looks to the payer. The quickstart sends merchants to the plugin README's
illustrated walkthrough; this file is for contributors and support, when the
walkthrough is not enough. Every setting, route, state and probe is specified
in the [BTCPay plugin reference](../guides/btcpay-reference.md), and what an
error message means is its
[Troubleshooting](../guides/btcpay-reference.md#troubleshooting) section;
this file repeats neither.

## Connecting the wallet

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
3. Click **Save NWC Code**. The plugin writes the
   connection string `type=openreceive;nwc=<NWC URI>` into the store's
   BTC-Lightning payment method through BTCPay's own validation path, and
   enables LNURL-pay the way BTCPay's Lightning settings page does. From
   then on the section is one line ("Wallet connected. Invoices are minted
   in wallet 3869…0c76 via relay.example") with a **Run a health check**
   button that shows the probes in place (the wallet preflight among them);
   a collapsed **Change NWC receive code** disclosure holds the box for a
   new code and its **Save NWC Code** button.

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

## Turning on swaps

Swaps need step 3 first: they settle into the OpenReceive wallet, and a store
on any other Lightning backend sees no swap options. The **Swaps** section
only appears once a wallet is connected.

1. Paste the LSC code into **Lightning Swap Connect code (primary)**.
2. Click **Test provider** to fetch the provider's catalog and see which
   assets it offers right now, with their limits.
3. Click **Save swap settings**. A saved primary code is what turns swaps
   on; removing it turns them off. There is no separate switch (the
   Greenfield `swapsEnabled` field can still pause swaps while keeping the
   code). Every asset the provider supports is offered; there is no per-store
   asset list. Once saved, the section is one line ("Swaps on. Provider
   ff.io.") and the form sits behind **Change swap provider**, where a
   collapsed **Backup provider** disclosure takes a second code used only
   while the primary is down.

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

## The doctor

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

BTCPay's own `LightningListener` is the settlement authority; the plugin's
client only answers its questions. The scan memo, the notification path and
the "unknown hash is unpaid, never missing" rule are in the reference's
[Settlement](../guides/btcpay-reference.md#settlement) section.

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

The merchant routes, their permissions and their fields are the
[Routes](../guides/btcpay-reference.md#routes) table of the reference. What
the table does not spell out:

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

## Run the regtest stack

`packages/dotnet/docker/` is a complete regtest environment in Docker;
[the .NET workspace README](../../packages/dotnet/README.md) documents
`up.sh`, `e2e.sh`, `test-e2e.sh`, `browser-e2e.sh` and `down.sh`, and
[the manual E2E checklist](btcpay-e2e.md) lists what only a real wallet and a
real provider can prove.
