# Automated swaps

A swap lets the payer send another asset (USDT, USDC, SOL, ETH, …) and still
settle your Lightning invoice. OpenReceive mints a Lightning invoice in your
wallet, asks the configured provider for deposit instructions, and stores both
on one payment-attempt row before the payer sees anything.

Turn swaps on with `LSC_URI_PRIMARY` (and optional `LSC_URI_BACKUP`) —
[Environment variables](environment-variables.md). While the primary is up,
only the primary is used. Backup is for outage, not for assets the primary
omits. [Lightning Swap Connect](lightning-swap-connect.md) is the URI format.

On BTCPay Server the plugin's setup page takes the same codes, and the swap
targets the BTCPay invoice's existing Lightning BOLT11; the provider states
and reasons below are the same, but the refund form lives on BTCPay's own
checkout page ([BTCPay quickstart](quickstart-btcpay.md)). The rest of this
guide is about the Node and Rails hosts.

OpenReceive quotes a small fixed list of pay-in assets into Lightning. It does
not merge the provider's full market dump.

`swap_data` on the attempt row holds provider credentials. It is server-only.
Never return it to the browser or log it. Provider `completed` is not
payment — the wallet still has to report the Lightning invoice settled.

## Turning swaps on is a commitment to refunds

A Lightning payment either arrives or it does not. A swap deposit can arrive
short or late. Then it sits at the provider as `refund_required`, and only
your UI can claim it.

The payer almost always leaves the page to fetch a refund address from
another wallet. So the order needs its own URL, your app needs a route that
restores that order, and something has to restore the **attempt** —
`/checkouts/prepare` returns none, and a checkout rebuilt from the reference
alone opens on the method grid.

[Swap refunds](swap-refunds.md) is that whole path. Read it before you set
`LSC_URI_PRIMARY`.

Refunds are authorized by your app. The library refreshes provider state
immediately before requesting the refund and refuses any state other than
`refund_required`.

## Deposit QR amount prefill

Native-coin rails (`ETH_ETH`, `SOL_SOL`) put the amount in the QR. Token
rails (`USDT_TRON`, `USDT_ETH`, `USDC_ETH`) encode the address only. On
those rails the payer types the amount by hand — give it its own labelled
copy row, and copy the number bare (`0.032664`, not `0.032664 SOL`).

See [Checkout UX](checkout-ux.md) and
[Headless checkout → The deposit values are the payer's to reproduce](headless-checkout.md#the-deposit-values-are-the-payers-to-reproduce).

## Which deposits can actually be mis-sent

Some deposit addresses pin the chain (a Solana address is Solana-only).
Others do not (a `0x…` address is the same string on several EVM chains).
The display model already scopes the warning: render
`swap.networkWarningTitle` and `swap.networkWarning`, and read `depositRisk`
if you need your own chrome. Do not hard-code one banner for every coin.

## Provider state after settlement

Once the wallet reports the Lightning invoice settled, the order's outcome
cannot change, so OpenReceive stops polling the provider. The stored
`provider_state` can lag — a settled order may still record
`awaiting_deposit`. That is expected.

Checkout panels show final payment confirmation. The transaction-details
row is labelled **Last provider state**. If you need the provider's
terminal record (a payout txid), call `getSwap` with the stored `swap_data`
at any time.
