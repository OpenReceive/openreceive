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

The consequence for the UI: on a token rail the payer **types six decimals by
hand**, and a short send against a fixed-rate order becomes `refund_required` —
a refund-address form and a round trip. So the amount is not a caption. It gets
its own labelled row with a copy button, beside the address and the memo, and it
is copied **bare** — the number alone, because `0.032664 SOL` is not something a
wallet's amount field accepts. Both shipped panels do this; a custom UI owes the
payer the same. See
[The deposit values are the payer's to reproduce](headless-checkout.md#the-deposit-values-are-the-payers-to-reproduce).

## Which deposits can actually be mis-sent

The deposit panel leads with a red banner on most rails and a quiet heading on
others, and the split is not arbitrary. The exposure comes from the deposit
**address** failing to pin the chain or the asset — never from whether the coin
is native:

| Rail | Address | Reachable mistake | Panel |
| --- | --- | --- | --- |
| `ETH_ETH` | `0x…` | chain ambiguous | full alarm |
| `USDT_ETH` | `0x…` | chain + asset ambiguous | full alarm |
| `USDC_ETH` | `0x…` | chain + asset ambiguous | full alarm |
| `USDT_TRON` | `T…` | chain pinned, but USDT is in every exchange's withdrawal dropdown on a dozen chains | full alarm |
| `SOL_SOL` | base58 ed25519 | neither: SOL exists on no other chain | quiet |

A `0x…` address is byte-identical on Ethereum, Arbitrum, Optimism, Base, BSC and
Polygon; nothing in it says which chain, and an exchange will happily withdraw
to it on the wrong one. A Solana address decodes to exactly a 32-byte ed25519
public key, and SOL exists nowhere else — so a red "wrong currency or network =
lost funds" banner on that screen is warning the payer about a mistake the
address format prevents.

Note the counter-intuitive half: **`ETH_ETH` is a native coin and needs the
alarm most of anything on the list.** "Native coin" is not the axis; address
ambiguity is. That is the opposite of the split in
[Deposit QR amount prefill](#deposit-qr-amount-prefill) above, which really is
native-vs-token — the two sections ask different questions about the same rails.

This is proportionality, not a downgrade of a funds-safety warning. The warning
is not literally false on `SOL_SOL` — a payer can send an SPL token to that
address and it will not credit the order, so the panel still states the exact
amount and still says to pay with one method only. What it drops is the alarm,
because a banner shown on every rail is read on none, and the rails where it is
load-bearing (USDT on four networks, ETH on six) are the ones that pay for the
erosion.

The classification is **derived, not tabulated**: `swapDepositRisk(payInAsset)`
asks whether the address format pins the chain and whether the asset is that
chain's native coin, so a rail added tomorrow is classified without an edit —
and an unrecognized one falls through to the full alarm rather than inheriting
the quiet heading. A custom UI reads `depositRisk` off the swap display model
(`"chain_ambiguous" | "asset_only" | "pinned"`) and picks its own chrome; there
is no need to keep a rail list of your own.

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
