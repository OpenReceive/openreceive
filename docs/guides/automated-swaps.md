# Automated swaps

A swap creates a shadow Lightning invoice in the merchant wallet, then asks a configured
provider for deposit instructions. Both values are committed on one `openreceive_payments`
attempt row before those instructions reach the payer. One row holds exactly one provider
order; a swap retry creates another row with a fresh invoice hash.

Your application configures provider credentials with optional `LSC_URI_PRIMARY` and
`LSC_URI_BACKUP` environment variables ([Environment variables](environment-variables.md)).
Primary is used exclusively while it is healthy; backup is only for primary outage. See
[Lightning Swap Connect](lightning-swap-connect.md) for the URI grammar and
security requirements. OpenReceive only quotes its small fixed pay-in asset
list into Lightning — provider market dumps are not merged in.

The two recovery planes are independent:

- wallet settlement is proven by payment hash through NWC;
- unresolved provider state is queried with the provider details in `swap_data`.

`swap_data` is a JSON-serializable object containing provider order credentials. It lives only
on the attempt row and stays server-only; never return it to browsers or log it. Applications may use
framework/database field encryption, but OpenReceive does not require a separate encryption
key. Provider `completed` does not fulfill an order unless the wallet also reports settlement.

Refunds are authorized by your application and pass the row's `reference`, `paymentHash`, `swapData`, and
refund address. The wallet client refreshes provider state immediately before requesting the refund
and refuses states other than `refund_required`.

## Deposit QR amount prefill

Only the **native-coin** rails encode an amount in the QR the payer scans:
`ETH_ETH` emits `ethereum:<address>?value=<wei>` and `SOL_SOL` emits
`solana:<address>?amount=<sol>`. Token rails — `USDT_TRON`, `USDT_ETH`,
`USDC_ETH`, and any future ERC-20/TRC-20 asset — encode the **bare deposit
address**: the EIP-681 token-transfer form is parsed inconsistently across
wallets, and a wallet that mis-parses it shows the payer a broken request
rather than no prefill. On those rails the panel's "send exactly X" line is the
amount of record.

What never happens is a silent downgrade. A `deposit_amount` the checkout
cannot convert raises, and the payer sees the panel's error surface — an
amount-less payment URI would be worse than either alternative, because the
wallet then lets the payer type any amount against a fixed-rate order.

## Provider state after settlement

Once the wallet reports the shadow invoice settled, the order's outcome can no longer change,
so OpenReceive stops polling the provider. The stored `provider_state` is therefore the last
snapshot taken _before_ settlement, and it can lag arbitrarily far behind the provider's real
terminal status. A fast provider can run its whole deposit → payout sequence inside one poll
interval — a settled order can legitimately still record `awaiting_deposit` even though the
provider finished (paying the Lightning invoice is what settled the order).

This is by design, not data loss:

- settlement authority is the wallet sweep, proven by payment hash — never provider status;
- continued provider polling after settlement would spend provider request budget to learn
  nothing that can change the order.

The transaction-details UI reflects this by labeling the row **Last provider state** (instead
of **Provider state**) once the order is settled. Checkout panels ignore the stale snapshot
entirely and show final payment confirmation. If an application wants the provider's terminal record
(e.g. the payout transaction id) for bookkeeping, it can call `getSwap` with the stored
`swap_data` at any time — provider status remains queryable after settlement.
