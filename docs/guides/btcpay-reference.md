# BTCPay plugin reference

Everything the OpenReceive BTCPay Server plugin exposes, in one place: the
connection string, the settings, the routes, the swap states and what to do
about each, the doctor probes, the log events, the database, and the
operations that are yours. The walkthrough is the
[BTCPay Server quickstart](quickstart-btcpay.md).

## Versions

| Plugin | BTCPay Server | .NET | NNostr.Client |
| --- | --- | --- | --- |
| lockstep with the OpenReceive workspace (`0.4.3` today) | 2.4.2 or later (compiled against 2.4.2) | 10 | 0.0.55 |

The plugin identifier is `BTCPayServer.Plugins.OpenReceive`. A plugin version
is a `System.Version`, so a workspace prerelease such as `0.5.0-alpha.0`
stamps `0.5.0`.

## The connection string

```text
type=openreceive;nwc=<NWC URI>[;allow-spend=true]
```

- `nwc=` is a `nostr+walletconnect://` URI: a 64-hex wallet pubkey, one or
  more `relay=wss://…` parameters, exactly one 64-hex `secret`, an optional
  `lud16`. Relays must be `wss`.
- `allow-spend=true` is the explicit override for a wallet that advertises a
  spend method. It is the only place the override lives; the setup page reads
  it from here.
- The plugin never claims a bare `nostr+walletconnect://` string or
  `type=nwc;key=…`. Both belong to the Nostr plugin.

BTCPay persists the string as the store's BTC-Lightning payment-method
configuration, the same slot every Lightning backend uses. It is visible to
store owners and through Greenfield, like an LND macaroon.

## What saving checks

Every save, from the setup page or from Greenfield, runs the receive-only
preflight through BTCPay's own Lightning validation path. The checks, in
order, and the code each refusal carries:

| Check | Code | Message says |
| --- | --- | --- |
| The relay answers and has a kind-13194 info event | `relay_unreachable`, `no_info_event` | which relay, and what to check |
| `get_info` answers | `get_info_failed` | the wallet's error |
| `make_invoice` and `list_transactions` are granted | `missing_required_method` | which one is missing |
| The wallet advertises `nip44_v2` or `nip04` | `unsupported_encryption` | the modes it advertised |
| No spend method (`pay_invoice`, `multi_pay_invoice`, `pay_keysend`, `multi_pay_keysend`) unless overridden | `spend_capability_advertised` | the methods found and the help link |
| The wallet's network equals BTCPay's | `network_mismatch` | both networks |

`lookup_invoice` is never required. When the wallet grants it, the client uses
it as a single-hash refresh between scans.

Relay hosts, and the LSC provider host, on the local network (loopback, RFC
1918, link-local, `.internal`/`.local`/`.lan`, or a bare single-label name)
need the server-settings permission: BTCPay's own rule for `server=` in a
Lightning connection string, applied by the setup page and the Greenfield
route to the hosts that rule cannot see. BTCPay's generic Lightning node page
does not look inside `nwc=`; on a shared server, keep store owners on the
plugin's page.

## Store settings

Kept in BTCPay's per-store settings under the name `OpenReceive`; never in the
connection string.

| Field | Meaning |
| --- | --- |
| `LscPrimary` | The Lightning Swap Connect URI (`lightning+swapconnect://host/path?key=…&secret=…`). Server-only; the setup page shows it redacted and never sends it back to the browser. |
| `LscBackup` | A second LSC URI, used only while the primary has failed within the last 60 seconds. |
| `SwapsEnabled` | Whether the checkout offers swap pills. The setup page derives it from `LscPrimary` (saved code = on); Greenfield follows the same rule unless `swapsEnabled` is sent explicitly. Requires the store's Lightning node to be an OpenReceive connection. |
| `LastPreflight` | Non-secret snapshot of the last wallet test: when, ok or the code, methods, encryption, notifications, network, relay round trip. |

Enabling swaps raises the store's invoice expiration to 60 minutes when it is
shorter. The plugin never lowers it.

## Routes

### Merchant (Greenfield API key, store permissions)

| Route | Permission | Body / result |
| --- | --- | --- |
| `GET /api/v1/stores/{storeId}/openreceive/settings` | view store settings | `lightningNodeIsOpenReceive`, `lightningNode` (redacted), `allowSpendCapableWallet`, `swapsEnabled`, `lscPrimaryConfigured`, `lscBackupConfigured`, `invoiceExpirationMinutes`, `lastPreflight` |
| `PUT /api/v1/stores/{storeId}/openreceive/settings` | modify store settings | any of `nwcUri`, `allowSpendCapableWallet`, `lscPrimary`, `lscBackup`, `swapsEnabled`; `nwcUri` runs the preflight and makes the wallet the Lightning node; `allowSpendCapableWallet` alone re-saves the current code with that override. Every field is checked before anything is written. 422 with `wallet_refused`, `wallet_required`, `lsc_required`, `invalid_lsc_uri` or `endpoint_not_allowed` when refused. |
| `POST /api/v1/stores/{storeId}/openreceive/wallet/test` | modify store settings | `{ nwcUri?, allowSpendCapableWallet? }` → the preflight snapshot (also stored as `lastPreflight`); an omitted override means the saved one |
| `GET /api/v1/stores/{storeId}/openreceive/swaps?limit=50` | view store settings | recent swap rows |
| `GET /api/v1/stores/{storeId}/openreceive/invoices/{invoiceId}/swaps` | view store settings | the invoice's swap rows |

A swap row: `id`, `invoiceId`, `paymentHash`, `provider`, `providerOrderId`,
`payInAsset`, `depositAddress`, `depositAmount`, `providerExpiresAt`, `state`,
`stateReason`, `attention`, `attentionReason`, `pluginReason`,
`refundReason`, `refundAddress`, `refundTxId`, `depositTxId`, `payoutTxId`,
`walletSettledAt`, `createdAt`, `updatedAt`. Never the provider token.

### Payer (anonymous; the invoice id is the bearer, as for BTCPay's own checkout)

| Route | Body / result |
| --- | --- |
| `POST /api/plugins/openreceive/swaps` | `{ invoiceId, payInAsset }` → the swap snapshot; 409 with a reason when swaps are not offered for the invoice |
| `GET /api/plugins/openreceive/swaps/{invoiceId}/{swapId}` | the snapshot, including `invoice_status` and `wallet_settled`; the checkout polls it every 5 s |
| `POST /api/plugins/openreceive/swaps/{invoiceId}/{swapId}/refund` | `{ refundAddress }` → the snapshot; 400 `invalid_refund_address`, 409 `refund_not_required` or `refund_already_requested` |

These routes are not in a BTCPay rate-limit zone: BTCPay's public-invoices zone
delays excess requests (4 per minute, burst 10), which would stall the poll
and a payer trying several assets. What bounds abuse: the invoice id must be
known, a repeat create for the same invoice and asset re-serves the live row
without calling the provider, and every provider call goes through the
per-provider weight budget (a create costs 50 of 150 per minute).

Snapshot fields are snake_case: `swap_id`, `state`, `phase`, `terminal`,
`label`, `detail`, `deposit_address`, `deposit_memo`, `deposit_amount`,
`deposit_uri` (native rails carry the amount in a `solana:` or `ethereum:`
URI; token rails encode the bare address), `provider_expires_at`,
`expires_in_seconds`, `deposit_risk` (`pinned`, `asset_only`,
`chain_ambiguous`), `network_warning_title`, `network_warning`, `fee`
(`currency`, `pay_in_fiat`, `payout_fiat`), refund and transaction ids,
`attention_reason`, `plugin_reason`, `provider_order_id`.

Reasons a swap is not offered (`POST` 409 and the reason the pills are
hidden): `lightning_node_not_openreceive`, `swaps_disabled`,
`provider_unconfigured`, `invoice_not_payable`, `top_up_invoice`,
`no_lightning_prompt`, `partial_payment`, `invoice_reminted`,
`invoice_expires_too_soon`. Per-asset refusals: `amount_too_small`,
`amount_too_large`, `pair_temporarily_unavailable`, `provider_rate_limited`,
`provider_unreachable`.

## Checkout integration

BTCPay's checkout is a Vue 2 app. The plugin renders one pill per offered
asset with the pseudo payment-method id `OpenReceiveSwap_<asset>`; an asset
the invoice cannot use is a greyed pill, and one line under the pill row says
why in the shopper's terms ("Below the minimum for this invoice: USDT · Tron
(at least 9.12 USD)"), the bound converted at the invoice's own rate, as the
JS checkout does. The plugin
registers a Vue component named `OpenReceiveSwap_<asset>Checkout`, which is
the name BTCPay mounts for a plugin method. BTCPay stops refreshing invoice
status while a plugin method is selected, so the component polls the swap
every 5 seconds and refreshes the invoice through BTCPay's own status
endpoint; BTCPay's paid screen then takes over by itself. The component is
`Resources/js/openreceive_swap_checkout.js`, served at
`/Resources/js/openreceive_swap_checkout.js`.

## Swap states and what to do

States, phases and reasons are the shared OpenReceive vocabulary
(`spec/data/kernel-tables.json`).

| State | Phase | The payer sees | The merchant does |
| --- | --- | --- | --- |
| `awaiting_deposit` | awaiting_deposit | address, amount, QR, countdown | nothing |
| `confirming`, `exchanging`, `paying_invoice` | processing | a spinner and the step | nothing |
| `completed` | settling | "Finalizing checkout" until BTCPay's paid screen | nothing; BTCPay records the Lightning payment |
| `refund_required` | refund | the refund-address form, with the reason (`underpaid`, `overpaid`, `late_deposit`, `underpaid_and_late`, `overpaid_and_late`) | nothing, unless the payer cannot reach the page: the invoice page shows the provider order id for the provider's support |
| `refund_pending`, `refunded` | refund | the refund address and, once known, the refund transaction | nothing |
| `expired` | terminal | "Expired" | nothing; `stateReason` says why (`no_deposit_before_provider_expiry`, `superseded_near_provider_expiry`) |
| `attention` | attention | "Needs attention" and the provider order id | review with the provider: `provider_reported_emergency`, `provider_status_unrecognized`, or `provider_completed_without_wallet_settlement` (the provider says it paid, the wallet never saw it, 30 minutes passed) |
| `failed` | terminal | "Failed" | nothing |

`pluginReason = invoice_reminted_after_partial_payment` marks rows whose
invoice received a partial Lightning payment and was re-minted by BTCPay; the
plugin stops offering swaps for that invoice but keeps polling the rows,
because an order already paying the old BOLT11 most likely still lands.

Polling: every 5 seconds per live row, 30 seconds once the invoice's
Lightning side settled, in batches of 200 due rows selected in SQL (least
recently polled first, so a backlog rotates). A `completed` row whose
Lightning side settled is done: it leaves the poll set and stays as the
record. A row with no deposit 15 minutes after the provider's window closes
is closed as `expired`. A `completed` row without wallet settlement for 30
minutes becomes `attention`.

Every row carries a version (Postgres `xmin`). The poller, a payer's refund
and BTCPay's payment event each write only the version they loaded; a write
that lost the race is re-read and applied again when it must land (a refund
address, a Lightning stamp, a re-mint mark) or left to the next tick when it
was a status refresh. Creating and refunding also take a Postgres advisory
lock per invoice and asset, or per swap, so two workers never mint two
orders or send the provider two refund addresses.

## Settlement

BTCPay's `LightningListener` settles invoices; the plugin's Lightning client
only answers its questions.

- `CreateInvoice` → NIP-47 `make_invoice`. Amount within 1,000 msat and the
  JSON safe-integer ceiling, description or description hash, expiry as
  requested; a wallet that mints a different expiry (beyond 60 seconds) is
  refused. Top-up invoices (no amount) are refused with a clear message.
- `GetInvoice` → the connection's scan memo: one `list_transactions` walk
  (settled view, then unpaid view; pages of 20; 24-hour window; deduplicated;
  truncation-safe) shared by every caller, refreshed every 2, 6 or 12 seconds
  depending on the age of the newest live invoice (minted by this process, or
  seen pending in a walk after a restart). A caller that gives up (an aborted
  checkout request) stops waiting without cancelling the shared walk; rows
  older than the window are forgotten after a walk. Paid when
  the settlement rule says settled (`settled_at > 0`, or `state` /
  `transaction_state` equal to `settled`; a preimage alone never), Expired
  only when the wallet's own row says expired or failed, Unpaid otherwise,
  including for a hash the memo has not seen.
- `Listen` → `payment_received` notifications (kind 23197 under NIP-44,
  23196 under NIP-04) when the wallet advertises them: a payload with a
  finality signal and an amount settles directly; without an amount the hash
  is refreshed first; without a finality signal one bounded scan runs. Behind
  the pushes a memo pass every 60 seconds is the safety net for a push the
  relay dropped; both paths emit through one queue, so a settlement seen by
  both is reported once. Else the poll listener, which is the memo refresh.
- Every NIP-47 reply is bound to the wallet: the relay filter and a local
  check require the wallet's pubkey as author (NNostr verifies the
  signature), the response kind, and an `e` tag naming the request. Nobody
  else on a public relay can answer for the wallet, and a relay cannot serve
  an older reply.
- Everything that could spend (`Pay`, keysend, `OpenChannel`,
  `GetDepositAddress`, `ConnectTo`, `CancelInvoice`, `ListChannels`,
  `GetPayment`, `ListPayments`) throws "OpenReceive is receive-only". `GetInfo`
  is unsupported; `GetBalance` works when `get_balance` is granted.

## The doctor

`/plugins/{storeId}/openreceive/doctor`, store-owner only, read-only. The
setup page's "Run a health check" button renders the same probes in place;
the page is titled "OpenReceive health check".

| Probe | Green when |
| --- | --- |
| Lightning node is an OpenReceive connection | the BTC-LN config carries `type=openreceive` |
| Wallet preflight (now) | the checks above pass right now |
| Wallet pushes payment notifications | the info event advertises `payment_received` |
| Last wallet scan | this process has walked the wallet at least once (and whether the walk was complete) |
| Spend-capable override is ON | shown only when the override is set; always a warning |
| Top-up invoices are not supported | always informational |
| Swap provider configured / reachable | with swaps on: an LSC is saved and its catalog loads, listing the available assets |
| Invoice expiration covers the provider window | 45 minutes or more (60 recommended) |
| Swaps needing attention | no row in `attention` |
| Invoice expiration within the scan window | 24 hours or less |

## Log events

All `Information` unless noted, under the `BTCPayServer.Plugins.OpenReceive.*`
categories. Secrets never appear; the wallet is named by its pubkey.

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
| `swap.create.failed`, `swap.catalog.failed`, `swap.poll.failed`, `swap.provider.down` (warnings) | provider trouble; `swap.provider.down` starts the 60-second backup window |
| `nwc.preflight.spend_override` (warning) | on every preflight of an overridden connection |

## Database

Schema `BTCPayServer.Plugins.OpenReceive`, table `openreceive_swaps`, one
migration (`20260903000000_InitialSwaps`) applied by BTCPay at startup with
its own migrations history table. Indexes: `invoice_id`, `store_id`, unique
`(provider, provider_order_id)`, and unique `(invoice_id, pay_in_asset)`
restricted to non-terminal rows, which is what makes "one live order per
invoice and asset" hold across BTCPay workers. Every update is conditional on
the row's `xmin` (no extra column). The provider token is a plain column,
like every other BTCPay credential; guard the database.

Nothing is written for plain Lightning invoices: BTCPay's invoices and
payments are the record.

## Operations

- **Rotating the NWC code**: paste the new code, Test, Use. The old
  connection's in-memory scan memo is dropped when BTCPay restarts; until then
  it costs nothing.
- **Rotating the LSC code**: save the new URI. Rows created under the old
  provider name are polled by name, so keep the old URI as backup until they
  are terminal.
- **Two BTCPay workers**: fine for correctness. Row writes are versioned,
  creation and refunds take advisory locks, the poller's due set is computed
  in SQL so both share one backlog, and the settings cache is 5 seconds, so a
  save on one worker reaches the other within that. What is per process: the
  scan memo (each worker pays one walk per interval) and the provider weight
  budget (two workers can spend twice the provider's per-minute allowance).
- **Beside the Nostr plugin**: each plugin loads its own copy of NNostr in
  its own load context (BTCPay's loader shares host types only), so the two
  never fight over an assembly version; they also do not share relay sockets.
- **Upgrading BTCPay**: the plugin declares `BTCPayServer >= 2.4.2`. Rebuild
  against the new version when BTCPay changes its Lightning interfaces; the
  Nostr and Blink plugins are the canary.
- **Uninstalling**: remove the plugin directory and restart BTCPay, then set
  a different Lightning node on the store. The table stays; drop the schema
  by hand if you want it gone.
- **Refund after the invoice expired**: the row stays on the invoice page
  with the provider order id; the payer's refund goes through the provider's
  support with that id.

## Testing

| Command | What it proves |
| --- | --- |
| `npm run test:dotnet` | 283 unit tests: every shared vector family the `dotnet` coverage entry does not exclude, the kernel against an in-process wallet, the swap service against the fake provider |
| `packages/dotnet/docker/up.sh`, then `e2e.sh` | the whole path over HTTP against BTCPay 2.4.2 in Docker |
| `packages/dotnet/docker/test-e2e.sh` | the same legs as xunit, inside the .NET SDK image |
| `packages/dotnet/docker/browser-e2e.sh` or `npm run test:e2e:btcpay` | the setup page, doctor and checkout in Chromium, including the swap component to "Invoice Paid" |
| `docs/internal/btcpay-e2e.md` | the manual checklist: mutinynet with Alby Hub, coexistence with the Nostr plugin, one real provider swap per release |

## Related

- [BTCPay Server quickstart](quickstart-btcpay.md)
- [Security](security.md)
- [Lightning Swap Connect](lightning-swap-connect.md)
- [Automated swaps](automated-swaps.md)
- [Swap refunds](swap-refunds.md)
