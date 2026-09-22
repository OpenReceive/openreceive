# Automated swaps

A swap lets the payer send a different asset and still settle your Lightning
invoice. Before the payer sees anything, OpenReceive does three things:

1. It creates a Lightning invoice in your wallet.
2. It asks the configured provider for deposit instructions.
3. It stores both on one payment-attempt row.

OpenReceive knows seven pay-in assets. They are listed in
`spec/data/kernel-tables.json`, and every engine builds its tables from that
file:

- **USDT** on Tron, Ethereum and Solana
- **USDC** on Ethereum and Solana
- **ETH** on Ethereum
- **SOL** on Solana

Bitcoin over Lightning is never a swap. The configured provider's catalog on
the day decides which of the seven a checkout offers. If a provider does not
support one, it simply does not appear.

Turn swaps on with `LSC_URI_PRIMARY`, and optionally `LSC_URI_BACKUP`. See
[Environment variables](environment-variables.md). While the primary is up,
OpenReceive uses only the primary. The backup is for outages, not for assets the
primary does not offer. The URI format is
[Lightning Swap Connect](lightning-swap-connect.md).

On BTCPay Server, you paste the same codes into the plugin's setup page. The
swap pays the BTCPay invoice's existing Lightning BOLT11. The provider states
and reasons below are the same. The refund form, though, is on BTCPay's own
checkout page ([BTCPay quickstart](quickstart-btcpay.md)). The rest of this
guide covers the Node and Rails hosts.

OpenReceive quotes a small, fixed list of pay-in assets into Lightning. It does
not merge in the provider's full market list.

`swap_data` on the attempt row holds provider credentials. Keep it on the
server. Never return it to the browser or log it. A provider `completed` state
does not mean the order is paid. The wallet still has to report the Lightning
invoice settled.

## Turning swaps on is a commitment to refunds

A Lightning payment either arrives or it does not. A swap deposit can arrive
short or late. When that happens it sits at the provider as `refund_required`,
and only your UI can claim it.

To get a refund address, the payer almost always leaves the page and opens
another wallet. So you need three things:

- The order needs its own URL.
- Your app needs a route that restores that order.
- Something has to restore the **attempt**. `/checkouts/prepare` returns no
  attempt, and a checkout rebuilt from the reference alone opens on the method
  grid.

[Swap refunds](swap-refunds.md) covers that whole path. Read it before you set
`LSC_URI_PRIMARY`.

Your app authorizes refunds. The library refreshes the provider state right
before it requests the refund, and refuses any state other than
`refund_required`.

## Deposit QR amount prefill

Native-coin rails (`ETH_ETH`, `SOL_SOL`) include the amount in the QR code.
Token rails (`USDT_TRON`, `USDT_ETH`, `USDC_ETH`) encode only the address. On
token rails the payer types the amount by hand. Give the amount its own
labelled copy row, and copy just the number (`0.032664`, not `0.032664 SOL`).

See [Checkout UX](checkout-ux.md) and
[Headless checkout → The deposit values are the payer's to reproduce](headless-checkout.md#the-deposit-values-are-the-payers-to-reproduce).

## Which deposits can actually be mis-sent

Some deposit addresses work on only one chain. A Solana address is
Solana-only. Others do not: a `0x…` address is the same string on several EVM
chains. The display model already shows the warning only where it applies.
Render `swap.networkWarningTitle` and `swap.networkWarning`. Read `depositRisk`
if you build your own UI around it. Do not hard-code one banner for every coin.

## Provider state after settlement

Once the wallet reports the Lightning invoice settled, the order's outcome
cannot change. So OpenReceive stops polling the provider. The stored
`provider_state` can therefore be out of date. A settled order may still show
`awaiting_deposit`. That is expected.

Checkout panels show the final payment confirmation. The transaction-details
row is labelled **Last provider state**. If you need the provider's final
record, such as a payout txid, call `getSwap` with the stored `swap_data` at
any time.
