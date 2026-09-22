# BTCPay plugin setup details

This is the long form of the [BTCPay quickstart](../guides/quickstart-btcpay.md).
It covers what each control on the setup page does, what saving checks, and how a
swap looks to the payer. The quickstart sends merchants to the illustrated
walkthrough in the plugin README. This file is for contributors and support, when
the walkthrough is not enough.

This file does not repeat two things:

- The [BTCPay plugin reference](../guides/btcpay-reference.md) specifies every
  setting, route, state and probe.
- Its [Troubleshooting](../guides/btcpay-reference.md#troubleshooting) section
  explains what each error message means.

## Connecting the wallet

Open the store, then click **OpenReceive** in the store navigation. It is also
under Wallets. The store dashboard shows a setup card until a wallet is connected.

1. Paste the receive-only NWC code into **Receive-only NWC code**.
2. Click **Test connection**. The report lists the wallet's methods, its
   encryption (`nip44_v2` preferred, `nip04` fallback), notifications,
   network, relay round trip and any spend methods found. If the code is
   refused, the report says why:
   - a receive method is missing
   - the encryption is unsupported
   - a spend method is advertised
   - the network does not match
   - the relay is unreachable
   - there is no NIP-47 info event
3. Click **Save NWC Code**. The plugin writes the connection string
   `type=openreceive;nwc=<NWC URI>` into the store's BTC-Lightning payment
   method, using BTCPay's own validation path. It also enables LNURL-pay, the
   same way BTCPay's Lightning settings page does. After that, the section
   shows one line ("Wallet connected. Invoices are minted in wallet 3869…0c76
   via relay.example") and a **Run a health check** button. The button shows
   the probes in place, including the wallet preflight. A collapsed
   **Change NWC receive code** disclosure holds the box for a new code and its
   **Save NWC Code** button.

The setup page is the whole install. You never open BTCPay's Lightning node
screen, and the plugin never reads the internal node.

Saving is refused if the wallet advertises a spend method such as
`pay_invoice`. Mint a receive-only code instead. If the wallet cannot do that,
tick **This wallet cannot mint a receive-only code and I accept the risk**. The
checkbox appears under the code field after a test finds a spend method. The
connection string then carries `;allow-spend=true`, and the plugin logs a
warning on every preflight. The plugin still never sends. It calls no NIP-47
`pay_*` method, whatever the wallet allows.

BTCPay stores the connection string like any other Lightning credential: in
its database, visible to store owners and through Greenfield. Because the code
is receive-only, a leak can do only limited damage.

## Turning on swaps

Swaps need step 3 first, because they settle into the OpenReceive wallet. A
store on any other Lightning backend sees no swap options. The **Swaps** section
appears only once a wallet is connected.

1. Paste the LSC code into **Lightning Swap Connect code (primary)**.
2. Click **Test provider**. It fetches the provider's catalog and shows which
   assets it offers right now, with their limits.
3. Click **Save swap settings**. Saving a primary code turns swaps on, and
   removing it turns them off. There is no separate switch, although the
   Greenfield `swapsEnabled` field can still pause swaps while keeping the
   code. Every asset the provider supports is offered. There is no per-store
   asset list. Once saved, the section shows one line ("Swaps on. Provider
   ff.io.") and the form moves behind **Change swap provider**. There, a
   collapsed **Backup provider** disclosure takes a second code, used only
   while the primary is down.

Saving a code raises **Store → Checkout → Invoice expiration** to 60
minutes if it is shorter. A swap needs at least 45 minutes of invoice life:
the provider's deposit window plus its settlement time. The plugin refuses to
create a swap in two cases:

- the invoice has less than the provider's window left (30 minutes by default)
- the invoice has received any partial Lightning payment

The LSC code is a bearer credential: whoever holds it can use it. It lives in
the plugin's per-store settings, on the server only. The provider's order token
never reaches a browser or a log. The setup page never shows a saved code again.
It shows the code redacted. An empty field keeps the saved code, a pasted code
replaces it, and a checkbox removes it. [Lightning Swap Connect](lightning-swap-connect.md)
defines the format.

Only a server admin can save a relay or provider on the local network. That
means loopback, a private range, a link-local address, a
`.internal`/`.local`/`.lan` name, or a bare single-label host. This is BTCPay's
own rule for Lightning connection strings. The plugin applies it to the hosts
that BTCPay's check does not see.

## The doctor

**Run a health check** on the setup page runs read-only probes right away.
**Health check** at the top right runs the same probes on their own page. The
probes check:

- the Lightning node is an OpenReceive connection
- the wallet passes preflight
- the wallet pushes `payment_received` notifications
- when the last wallet scan ran
- the swap provider is reachable, and which assets it offers
- the invoice expiration covers the provider window
- how many swaps need a human

Each failing probe carries a link to the fix.

## What is unsupported, by design

- Every send-side BTCPay feature: Lightning payouts, pull-payment refunds
  over Lightning, the wallet's send tab and channel management. The client
  throws a clear "receive-only" error for each.
- Top-up (amountless) invoices. Every invoice needs an amount. A top-up
  invoice fails with a clear message.
- A bare `nostr+walletconnect://` string in BTCPay's Lightning node screen.
  That form belongs to the Nostr plugin, which claims it without the
  receive-only guard. Only `type=openreceive;nwc=…` belongs to OpenReceive.
- Node information (`GetInfo`) and outgoing payment history, because the wallet is
  remote.

## Settlement

BTCPay's own `LightningListener` decides when an invoice is settled. The plugin's
client only answers its questions. The reference's
[Settlement](../guides/btcpay-reference.md#settlement) section covers the scan memo,
the notification path and the "unknown hash is unpaid, never missing" rule.

## Paying with a swap

The checkout shows one pill per offered asset ("USDT · Tron", "SOL · Solana",
…). When the payer picks one, the plugin creates a provider order that pays the
invoice's existing Lightning BOLT11. The checkout shows the deposit address, the
amount and a countdown. The plugin polls the provider. BTCPay's checkout switches
to paid when the wallet reports the Lightning payment.

If a deposit arrives short or late, the swap becomes `refund_required`. The same
checkout screen then shows a refund-address form, which validates the checksum for
the asset's network. While the invoice is still payable, reopening the invoice's
checkout page and picking the asset again serves the same order again. After the
BTCPay invoice expires, the merchant can still see the swap row on the invoice
page, with the provider order id. The refund then has to be arranged directly with
the provider.

Provider states, attention reasons and refund reasons use the shared OpenReceive
vocabulary. Timing rules:

- If the provider reports a swap `completed` but its Lightning side has not settled
  within 30 minutes, the swap is flagged for attention
  (`provider_completed_without_wallet_settlement`).
- If no deposit has arrived 15 minutes after the provider's window closes, the swap
  is closed as expired.
- The plugin polls the provider every 5 seconds. Once the invoice's Lightning side
  has settled, it polls every 30 seconds.

## Greenfield API

The [Routes](../guides/btcpay-reference.md#routes) table of the reference lists the
merchant routes, their permissions and their fields. This section covers what the
table does not spell out.

Swap rows never include the provider token. A refused update changes nothing,
because every field is checked before anything is written. The response carries a
`code`:

- `wallet_refused`: the preflight said no. Its message is included.
- `wallet_required`
- `lsc_required`
- `invalid_lsc_uri`
- `invalid_pay_in_asset`: an unknown asset name. An empty list offers every asset.
- `endpoint_not_allowed`: a local-network relay or provider, sent without server
  admin rights.
- `nwc_required`
- `invalid_nwc_uri`

`allowSpendCapableWallet` on its own re-saves the store's current code with that
override, through the same preflight.

The payer's swap routes are anonymous. They are addressed by invoice id plus swap
id. The invoice id acts as the bearer credential, as it does for BTCPay's own
checkout page. A repeat create serves the live order again without calling the
provider.

- `GET /api/plugins/openreceive/swaps/{invoiceId}?after={swapId}&limit=50`
  returns `{attempts, next_cursor}`, with at most 100 rows, including retired attempts.
- `GET /plugins/openreceive/invoices/{invoiceId}/recovery` is linked from checkout
  and from merchant details. It stays available after the invoice
  expires and after swaps are disabled.
- The individual routes are `POST /api/plugins/openreceive/swaps` `{invoiceId, payInAsset}`,
  `GET /api/plugins/openreceive/swaps/{invoiceId}/{swapId}`, and
  `POST /api/plugins/openreceive/swaps/{invoiceId}/{swapId}/refund`
  `{refundAddress}`.

The checkout component calls these routes. A custom checkout can call them too.

## Run the regtest stack

`packages/dotnet/docker/` is a complete regtest environment in Docker.
[The .NET workspace README](../../packages/dotnet/README.md) documents
`up.sh`, `e2e.sh`, `test-e2e.sh`, `browser-e2e.sh` and `down.sh`.
[The manual E2E checklist](btcpay-e2e.md) lists what only a real wallet and a
real provider can prove.
