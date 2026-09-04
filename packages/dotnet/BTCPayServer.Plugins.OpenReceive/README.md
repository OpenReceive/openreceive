# OpenReceive for BTCPay Server

Receive Lightning payments straight into a wallet you control, with a
receive-only NWC code. Optionally accept USDT, USDC, ETH and SOL through a
Lightning Swap Connect provider; swaps settle into the same wallet.

- **Receive-only.** The plugin checks the NWC code on save and refuses one
  that can spend. It never calls a send method, whatever the wallet grants.
  Lightning payouts and pull-payment refunds over Lightning are unavailable
  with this backend by design.
- **Your wallet is the store's Lightning node.** BTCPay mints every invoice in
  it and records payments with its own settlement machinery. The internal
  node is never used.
- **Swaps, server-side.** One pill per asset on the checkout, provider orders
  tracked in BTCPay's database, refunds on the same screen.

Setup: Store → **OpenReceive** → paste the code → **Test connection** → **Use
as this store's Lightning node**. A **Doctor** page checks the connection,
notifications, the provider and the invoice expiration.

Get a receive-only code: https://openreceive.org/get_a_nwc_code_to_receive_payments.
Guide: https://openreceive.org/guides/quickstart-btcpay. Requires BTCPay
Server 2.4.2 or later. MIT licensed; source at
https://github.com/OpenReceive/openreceive (`packages/dotnet`).
