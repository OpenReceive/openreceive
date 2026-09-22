# BTCPay plugin reference

This page lists everything the OpenReceive BTCPay Server plugin exposes:

- the connection string
- the settings
- the routes
- the swap states and what to do about each
- the doctor probes (health checks)
- the log events
- the database
- the operations you are responsible for

For a step-by-step setup, see the
[BTCPay Server quickstart](quickstart-btcpay.md).

## Versions

| Plugin | BTCPay Server | .NET | NNostr.Client |
| --- | --- | --- | --- |
| 0.4.11 | 2.4.4 or later (compiled against 2.4.4) | 10 | 0.0.55 |

The plugin identifier is `BTCPayServer.Plugins.OpenReceive`. The plugin is
versioned and published separately from the npm and gem releases.

Upgrading to 0.4.11 needs planning. It adds database migrations and changes how
existing rows are read. Before you install it over an earlier version, read
[the plugin's payment safety upgrade notes](https://github.com/OpenReceive/openreceive/blob/master/packages/dotnet/BTCPayServer.Plugins.OpenReceive/PAYMENT-SAFETY-UPGRADE.md).

## The connection string

```text
type=openreceive;nwc=<NWC URI>[;allow-spend=true]
```

- `nwc=` is a `nostr+walletconnect://` URI. It has a 64-hex wallet pubkey, one
  or more `relay=wss://…` parameters, exactly one 64-hex `secret`, and an
  optional `lud16`. Relays must be `wss`.
- `allow-spend=true` is the explicit override for a wallet that advertises a
  spend method. The override is stored only here. The setup page reads it from
  the string.
- The plugin never claims a bare `nostr+walletconnect://` string or
  `type=nwc;key=…`. Both belong to the Nostr plugin.

BTCPay saves the string as the store's BTC-Lightning payment-method
configuration. Every Lightning backend uses this same slot. Store owners can see
it, and so can Greenfield callers, just like an LND macaroon.

## What saving checks

Every save runs the receive-only preflight, whether it comes from the setup
page or from Greenfield. The preflight runs through BTCPay's own Lightning
validation. These are the checks, in order, with the code each refusal
carries:

| Check | Code | Message says |
| --- | --- | --- |
| The relay answers and has a kind-13194 info event | `relay_unreachable`, `no_info_event` | which relay, and what to check |
| `get_info` answers | `get_info_failed` | the wallet's error |
| `make_invoice` and `list_transactions` are granted | `missing_required_method` | which one is missing |
| The wallet advertises `nip44_v2` or `nip04` | `unsupported_encryption` | the modes it advertised |
| No spend method (`pay_invoice`, `multi_pay_invoice`, `pay_keysend`, `multi_pay_keysend`) unless overridden | `spend_capability_advertised` | the methods found and the help link |
| The wallet's network equals BTCPay's | `network_mismatch` | both networks |

`lookup_invoice` is never required. When the wallet grants it, the client uses
it to refresh a single hash between scans.

A relay host or LSC provider host on the local network needs the
server-settings permission. Local means loopback, RFC 1918, link-local,
`.internal`/`.local`/`.lan`, or a bare single-label name. BTCPay already applies
this rule to `server=` in a Lightning connection string. BTCPay cannot see these
hosts, so the setup page and the Greenfield route apply the same rule to them.
BTCPay's generic Lightning node page does not look inside `nwc=`. On a shared
server, have store owners use the plugin's page.

## Store settings

These live in BTCPay's per-store settings under the name `OpenReceive`. They
are never in the connection string.

| Field | Meaning |
| --- | --- |
| `LscPrimary` | The Lightning Swap Connect URI (`lightning+swapconnect://host/path?key=…&secret=…`). It stays on the server. The setup page shows it redacted and never sends it back to the browser. |
| `LscBackup` | A second LSC URI. It is used only while the primary has failed within the last 60 seconds. |
| `SwapsEnabled` | Whether the checkout offers swap pills. The setup page turns it on when `LscPrimary` holds a saved code. Greenfield follows the same rule unless the request sends `swapsEnabled` explicitly. The store's Lightning node must be an OpenReceive connection. |
| `LastPreflight` | A non-secret snapshot of the last wallet test: when it ran, ok or the refusal code, methods, encryption, notifications, network, and relay round trip. |

Turning swaps on raises the store's invoice expiration to 60 minutes if it is
shorter. The plugin never lowers it.

## Routes

### Merchant (Greenfield API key, store permissions)

| Route | Permission | Body / result |
| --- | --- | --- |
| `GET /api/v1/stores/{storeId}/openreceive/settings` | view store settings | `lightningNodeIsOpenReceive`, `lightningNode` (redacted), `allowSpendCapableWallet`, `swapsEnabled`, `lscPrimaryConfigured`, `lscBackupConfigured`, `invoiceExpirationMinutes`, `lastPreflight` |
| `PUT /api/v1/stores/{storeId}/openreceive/settings` | modify store settings | Any of `nwcUri`, `allowSpendCapableWallet`, `lscPrimary`, `lscBackup`, `swapsEnabled`. Sending `nwcUri` runs the preflight and makes the wallet the Lightning node. Sending `allowSpendCapableWallet` alone re-saves the current code with that override. Every field is checked before anything is written. A refusal returns 422 with `wallet_refused`, `wallet_required`, `lsc_required`, `invalid_lsc_uri` or `endpoint_not_allowed`. |
| `POST /api/v1/stores/{storeId}/openreceive/wallet/test` | modify store settings | `{ nwcUri?, allowSpendCapableWallet? }` → the preflight snapshot, also stored as `lastPreflight`. If you omit the override, the saved one is used. |
| `GET /api/v1/stores/{storeId}/openreceive/swaps?limit=50` | view store settings | recent swap rows |
| `GET /api/v1/stores/{storeId}/openreceive/invoices/{invoiceId}/swaps` | view store settings | the invoice's swap rows |

A swap row: `id`, `invoiceId`, `paymentHash`, `provider`, `providerOrderId`,
`payInAsset`, `depositAddress`, `depositAmount`, `providerExpiresAt`, `state`,
`stateReason`, `attention`, `attentionReason`, `pluginReason`,
`refundReason`, `refundAddress`, `refundTxId`, `depositTxId`, `payoutTxId`,
`walletSettledAt`, `createdAt`, `updatedAt`. It never includes the provider token.

### Payer (anonymous; the invoice id is the bearer, as for BTCPay's own checkout)

| Route | Body / result |
| --- | --- |
| `POST /api/plugins/openreceive/swaps` | `{ invoiceId, payInAsset }` → the swap snapshot. Returns 409 with a reason when swaps are not offered for the invoice. |
| `GET /api/plugins/openreceive/swaps/{invoiceId}?after={swapId}&limit=50` | A paged recovery list for the invoice, `{ attempts, next_cursor }`, including retired orders. Maximum 100. |
| `GET /plugins/openreceive/invoices/{invoiceId}/recovery` | The payer recovery page. It works after expiry and when swaps are disabled. |
| `GET /api/plugins/openreceive/swaps/{invoiceId}/{swapId}` | The snapshot, including `invoice_status` and `wallet_settled`. The checkout polls it every 5 s. |
| `POST /api/plugins/openreceive/swaps/{invoiceId}/{swapId}/refund` | `{ refundAddress }` → the snapshot. Errors: 400 `invalid_refund_address`, 409 `refund_not_required` or `refund_already_requested`. |

These routes are not in a BTCPay rate-limit zone. BTCPay's public-invoices zone
delays excess requests (4 per minute, burst 10). That would stall the poll and
slow down a payer who tries several assets. Abuse is limited in other ways:

- The caller must know the invoice id.
- A repeat create for the same invoice and asset returns the live row without
  calling the provider.
- Every provider call counts against the per-provider weight budget. A create
  costs 50 of 150 per minute.

Snapshot fields are snake_case:

- `swap_id`, `state`, `phase`, `terminal`, `label`, `detail`
- `deposit_address`, `deposit_memo`, `deposit_amount`
- `deposit_uri`. Native rails carry the amount in a `solana:` or `ethereum:`
  URI. Token rails encode the bare address.
- `provider_expires_at`, `expires_in_seconds`
- `deposit_risk` (`pinned`, `asset_only`, `chain_ambiguous`)
- `network_warning_title`, `network_warning`
- `fee` (`currency`, `pay_in_fiat`, `payout_fiat`)
- `fee_text`, the one-line fee explanation the checkout shows. For USDT and USDC
  it is stated in the token. It never repeats `pay_in_fiat`, because that would
  look like the deposit amount with a typo.
- refund and transaction ids
- `attention_reason`, `plugin_reason`, `provider_order_id`

Reasons a swap is not offered. These are the `POST` 409 reasons and the reasons
the pills are hidden: `lightning_node_not_openreceive`, `swaps_disabled`,
`provider_unconfigured`, `invoice_not_payable`, `top_up_invoice`,
`no_lightning_prompt`, `partial_payment`, `invoice_reminted`,
`invoice_expires_too_soon`. Per-asset refusals: `amount_too_small`,
`amount_too_large`, `pair_temporarily_unavailable`, `provider_rate_limited`,
`provider_unreachable`.

## Checkout integration

BTCPay's checkout is a Vue 2 app. The plugin renders one pill per offered
asset, with the pseudo payment-method id `OpenReceiveSwap_<asset>`. An asset
the invoice cannot use shows as a greyed pill. One line under the pill row
tells the shopper why, for example "Below the minimum for this invoice: USDT ·
Tron (at least 9.12 USD)". The limit is converted at the invoice's own rate,
the same way the JS checkout does it.

The plugin registers a Vue component named `OpenReceiveSwap_<asset>Checkout`.
BTCPay mounts a component with that name for a plugin payment method. BTCPay
stops refreshing invoice status while a plugin method is selected. So the
component polls the swap every 5 seconds and refreshes the invoice through
BTCPay's own status endpoint. BTCPay's paid screen then takes over on its own.
The component is `Resources/js/openreceive_swap_checkout.js`, served at
`/Resources/js/openreceive_swap_checkout.js`.

## Swap states and what to do

States, phases and reasons use the shared OpenReceive vocabulary in
`spec/data/kernel-tables.json`.

| State | Phase | The payer sees | The merchant does |
| --- | --- | --- | --- |
| `awaiting_deposit` | awaiting_deposit | address, amount, QR, countdown | nothing |
| `confirming`, `exchanging`, `paying_invoice` | processing | a spinner and the step | nothing |
| `completed` | settling | "Finalizing checkout" until BTCPay's paid screen | nothing. BTCPay records the Lightning payment. |
| `refund_required` | refund | the refund-address form, with the reason (`underpaid`, `overpaid`, `late_deposit`, `underpaid_and_late`, `overpaid_and_late`) | nothing, unless the payer cannot reach the page. The invoice page shows the provider order id to give the provider's support. |
| `refund_pending`, `refunded` | refund | the refund address and, once known, the refund transaction | nothing |
| `expired` | terminal | "Expired" | nothing. `stateReason` says why (`no_deposit_before_provider_expiry`, `superseded_near_provider_expiry`). |
| `attention` | attention | "Needs attention" and the provider order id | review with the provider. The reason is `provider_reported_emergency`, `provider_status_unrecognized`, or `provider_completed_without_wallet_settlement`. The last means the provider says it paid, but the wallet has not seen the payment after 30 minutes. |
| `failed` | terminal | "Failed" | nothing |

`pluginReason = invoice_reminted_after_partial_payment` marks rows whose
invoice received a partial Lightning payment, after which BTCPay created a new
invoice (re-minted it). The plugin stops offering swaps for that invoice. It
keeps polling the rows, because an order that is already paying the old BOLT11
will most likely still arrive.

Polling works like this:

- Each live row is polled every 5 seconds. Once the invoice's Lightning side
  has settled, it is polled every 30 seconds.
- The plugin selects due rows in SQL, in batches of 200. The least recently
  polled rows come first, so a backlog rotates.
- A `completed` row whose Lightning side has settled is done. It leaves the
  poll set and stays as the record.
- A row with no deposit 15 minutes after the provider's window closes is closed
  as `expired`.
- A `completed` row without wallet settlement for 30 minutes becomes
  `attention`.

Every row carries a version, the Postgres `xmin` column. The poller, a payer's
refund and BTCPay's payment event each write only if the row still has the
version they loaded. If a write loses that race, what happens next depends on
the write:

- A write that must land is re-read and applied again. This covers a refund
  address, a Lightning stamp and a re-mint mark.
- A status refresh is left for the next tick.

Creating and refunding also take a Postgres advisory lock, per invoice and
asset or per swap. This keeps two workers from creating two orders or sending
the provider two refund addresses.

## Settlement

BTCPay's `LightningListener` settles invoices. The plugin's Lightning client
only answers its questions.

- `CreateInvoice` → NIP-47 `make_invoice`.
  - The amount must be between 1,000 msat and the JSON safe-integer
    ceiling.
  - It sends a description or a description hash.
  - The expiry is what BTCPay requests, which is the store's invoice
    expiration, capped at 24 hours. Most NWC wallets allow no more. A wallet
    that shortened a longer request would fail the check that follows.
  - If the wallet creates the invoice with a different expiry (off by more than
    60 seconds), the plugin refuses it.
  - Saving the wallet lowers a store expiration above 24 hours to 24 hours, so
    the checkout timer and the invoice agree.
  - Top-up invoices (no amount) are refused with a clear message.
- `GetInvoice` → the connection's scan memo, an in-memory record of the
  wallet's recent transactions.
  - Every hash BTCPay asks about is watched, and so is every invoice minted
    here. A hash stays watched until the wallet's row is terminal. It also
    stops being watched if a complete walk at or after its expiry plus 900
    seconds still shows it unpaid.
  - One refresh walks `list_transactions` for exactly the watched hashes. It
    starts from the oldest watched pending invoice, minus 60 seconds. It reads
    the settled view first, then the unpaid view for whatever is still
    missing. It reads pages of 20 and stops as soon as it has seen every
    watched hash. If nothing is watched, a refresh costs nothing.
  - A walk can be cut short, by a wallet that ignores `offset` or by a page
    cap. A hash it could not reach is looked up with `lookup_invoice` when the
    wallet grants it. Otherwise it stays pending and watched for the next
    refresh. It is never closed.
  - After a restart the memo is empty. When BTCPay asks about a hash, the
    plugin first restores it from `openreceive_invoices`: its creation and
    expiry time, BOLT11 and amount. It is then walked for and closed exactly
    as before the restart.
  - Only a hash with no stored row has an unknown age. That is one minted
    before the plugin kept these rows, or one minted by another wallet. It is
    looked up first when the wallet grants `lookup_invoice`. Otherwise it is
    walked once with no lower time bound. If the relay fails a walk, the next
    refresh repeats it.
  - The memo refreshes every 2, 6 or 12 seconds, depending on the age of the
    newest live invoice. Every caller shares that refresh. A caller that gives
    up, such as an aborted checkout request, stops waiting but does not cancel
    the shared walk.
  - A hash is Paid when the settlement rule says settled: `settled_at > 0`, or
    `state` / `transaction_state` equal to `settled`. A preimage alone never
    counts. It is Expired only when the wallet's own row says expired or
    failed. Otherwise it is Unpaid, including a hash the memo has not seen.
- `Listen` → `payment_received` notifications, when the wallet advertises them.
  They are kind 23197 under NIP-44 and 23196 under NIP-04.
  - A payload with a finality signal and an amount settles directly.
  - Without an amount, the hash is refreshed first.
  - Without a finality signal, one bounded scan runs.
  - Behind the pushes, a memo pass runs every 60 seconds. It catches any push
    the relay dropped. Both paths report through one queue, so a settlement
    seen by both is reported once.
  - If the wallet does not advertise notifications, `Listen` uses the poll
    listener, which is the memo refresh.
- Every NIP-47 reply is bound to the wallet. The relay filter and a local check
  require three things: the wallet's pubkey as author (NNostr verifies the
  signature), the response kind, and an `e` tag naming the request. Nobody else
  on a public relay can answer for the wallet, and a relay cannot serve an
  older reply.
- Everything that could spend throws "OpenReceive is receive-only". That
  covers `Pay`, keysend, `OpenChannel`, `GetDepositAddress`, `ConnectTo`,
  `CancelInvoice`, `ListChannels`, `GetPayment` and `ListPayments`. `GetInfo`
  is unsupported. `GetBalance` works when `get_balance` is granted.

## The doctor

The doctor lives at `/plugins/{storeId}/openreceive/doctor`. Only store owners
can open it, and it changes nothing. The setup page's "Run a health check"
button shows the same probes right on the page. The page is titled
"OpenReceive health check".

| Probe | Green when |
| --- | --- |
| Lightning node is an OpenReceive connection | the BTC-LN config carries `type=openreceive` |
| Wallet preflight (now) | the checks above pass right now |
| Wallet pushes payment notifications | the info event advertises `payment_received` |
| Last wallet scan | this process has walked the wallet at least once. It also shows how many invoices it watches and whether any could not be reached. |
| Spend-capable override is ON | shown only when the override is set. Always a warning. |
| Top-up invoices are not supported | always informational |
| Swap provider configured / reachable | with swaps on, an LSC is saved and its catalog loads. It lists the available assets. |
| Invoice expiration covers the provider window | 45 minutes or more (60 recommended) |
| Swaps needing attention | no row in `attention` |
| Invoice expiration within a day | 24 hours or less. Lightning invoices are minted for at most a day. |

## Troubleshooting

- **"Could not reach the wallet through its relay"**. The relay in the NWC
  code is down, or the BTCPay host cannot reach it. Check outbound `wss://`
  access and the relay URL, then test again.
- **"No NIP-47 info event was found"**. The wallet service is offline, or the
  code names a relay the wallet does not publish to.
- **"advertises spend methods"**. The code can spend. Create a receive-only
  code, or tick the override and accept the risk.
- **"The wallet is on mainnet but this BTCPay Server runs on regtest"**. The
  networks must match. Connect a wallet on BTCPay's network.
- **Swaps are not offered on an invoice**. One of these is true, and the doctor
  names which:
  - The store's Lightning node is not the OpenReceive connection.
  - Swaps are off.
  - No LSC code is saved.
  - The invoice has less time left than the provider window.
  - The invoice received a partial payment.
  - It is a top-up invoice.
- **Invoice expiration**. A store with swaps on needs at least 45 minutes (60
  recommended). Above 24 hours, the checkout timer outlives the Lightning
  invoice, which is minted for at most a day. Saving the wallet lowers the
  store setting. The doctor flags the setting if someone raises it afterwards.
- **Payments settle slowly**. The wallet pushes no `payment_received`
  notifications, so settlement waits for the periodic scan (2–12 s). The
  doctor shows the notification probe and the last scan time.

## Log events

Events log at `Information` level unless noted, under the
`BTCPayServer.Plugins.OpenReceive.*` categories. Secrets never appear. The
wallet is identified by its pubkey.

| Event | When |
| --- | --- |
| `nwc.encryption.negotiated` | the scheme was chosen from the info event (`nwc.encryption.renegotiate` warns on a decrypt failure) |
| `nwc.preflight.ok`, `nwc.preflight.refused` (warning) | a save or test ran |
| `nwc.invoice.created` | `make_invoice` succeeded (hash, msats, expiry) |
| `nwc.listen.start` | BTCPay opened a listener (`mode=notifications` or `poll`) |
| `nwc.notification.received` | a `payment_received` arrived (type, hash) |
| `nwc.scan.settled`, `nwc.scan.memo` (debug), `nwc.scan.failed` (warning once, then debug until `nwc.scan.recovered`) | the poll listener |
| `nwc.notification.settled`, `nwc.sweep.failed` (warning once, then debug until `nwc.sweep.recovered`) | the notification listener's emit and its periodic sweep |
| `openreceive.setup.lightning_node_set`, `openreceive.setup.invoice_expiration_raised` | the setup page or API wrote store config |
| `swap.created`, `swap.state`, `swap.wallet_settled`, `swap.refund.requested` | the swap lifecycle |
| `swap.create.failed`, `swap.catalog.failed`, `swap.poll.failed`, `swap.provider.down` (warnings) | provider trouble. `swap.provider.down` starts the 60-second backup window. |
| `nwc.preflight.spend_override` (warning) | on every preflight of an overridden connection |

## Database

The plugin uses the schema `BTCPayServer.Plugins.OpenReceive`, with two tables.
Each table has one migration: `20260903000000_InitialSwaps` and
`20260920000000_MintedInvoices`. BTCPay applies them at startup and tracks them
in its own migrations history table.

`openreceive_invoices` holds one row per Lightning invoice the plugin mints.
The columns are `payment_hash`, `bolt11`, `amount_msats`, `created_at` and
`expires_at`. The plugin commits the row before BTCPay shows the invoice to a
payer, and never updates it. It plays the role of an `openreceive_payments`
row, cut down to what only the plugin knows. Status, settlement and fulfillment
live in BTCPay's own invoice and payment rows and are not copied.

`openreceive_swaps` holds one row per provider swap order. Its indexes are:

- `invoice_id`
- `store_id`
- unique `(provider, provider_order_id)`
- unique `(invoice_id, pay_in_asset)`, limited to non-terminal rows. This index
  is what guarantees "one live order per invoice and asset" across BTCPay
  workers.

Every update is conditional on the row's `xmin`, so no extra version column is
needed. The provider token is stored as a plain column, like every other
BTCPay credential. Protect the database.

BTCPay's invoices and payments remain the record of what was paid. The
plugin's rows only make sure a payment is found.

## Operations

- **Rotating the NWC code**: paste the new code, click Test, then Use. The old
  connection's in-memory scan memo is dropped when BTCPay restarts. Until then
  it costs nothing.
- **Rotating the LSC code**: save the new URI. Rows created under the old
  provider name are still polled by that name. Keep the old URI as the backup
  until those rows are terminal.
- **Two BTCPay workers**: payments stay correct.
  - Row writes are versioned.
  - Creation and refunds take advisory locks.
  - The poller computes its due set in SQL, so both workers share one backlog.
  - Settings are cached for 5 seconds, so a save on one worker reaches the
    other within 5 seconds.

  Two things are per process. Each worker has its own scan memo, and walks
  only for the invoices it was asked about, one walk per interval. Each worker
  also has its own provider weight budget, so two workers can spend twice the
  provider's per-minute allowance.
- **Beside the Nostr plugin**: each plugin loads its own copy of NNostr in its
  own load context. BTCPay's loader shares only host types. So the two plugins
  never conflict over an assembly version. They also do not share relay
  sockets.
- **Upgrading BTCPay**: the plugin declares `BTCPayServer >= 2.4.4`. When BTCPay
  changes its Lightning interfaces, rebuild against the new version. The Nostr
  and Blink plugins break first, so watch them as an early warning.
- **Uninstalling**: remove the plugin directory and restart BTCPay. Then set a
  different Lightning node on the store. The table stays. Drop the schema by
  hand if you want it gone.
- **Refund after the invoice expired**: the row stays on the invoice page with
  the provider order id. The payer gets the refund through the provider's
  support, using that id.

## Testing

| Command | What it proves |
| --- | --- |
| `npm run test:dotnet` | 283 unit tests. They cover every shared vector family the `dotnet` coverage entry does not exclude, the kernel against an in-process wallet, and the swap service against the fake provider. |
| `packages/dotnet/docker/up.sh`, then `e2e.sh` | the whole path over HTTP against BTCPay 2.4.4 in Docker |
| `packages/dotnet/docker/test-e2e.sh` | the same legs as xunit, inside the .NET SDK image |
| `packages/dotnet/docker/browser-e2e.sh` or `npm run test:e2e:btcpay` | the setup page, doctor and checkout in Chromium, including the swap component to "Invoice Paid" |
| `docs/internal/btcpay-e2e.md` | the manual checklist: mutinynet with Alby Hub, coexistence with the Nostr plugin, one real provider swap per release |

## Related

- [BTCPay Server quickstart](quickstart-btcpay.md)
- [Security](security.md)
- [Lightning Swap Connect](lightning-swap-connect.md)
- [Automated swaps](automated-swaps.md)
- [Swap refunds](swap-refunds.md)
