# BTCPay Server quickstart

Requires BTCPay Server ≥ 2.4.2.

The OpenReceive plugin makes a receive-only NWC wallet the Lightning node of a
BTCPay store. BTCPay mints every Lightning invoice in that wallet and records
payments through its own settlement machinery. Optionally, payers can pay a
BTCPay invoice with USDT, USDC, ETH or SOL through a Lightning Swap Connect
provider; the swap settles into the same wallet. The store's internal node is
never used.

This is not the Node or Rails library. There are no hooks, no
`openreceive_payments` table and no OpenReceive HTTP routes: BTCPay's
invoices, checkout, webhooks and Greenfield API are the host.

## 1. Prerequisites

- A BTCPay Server, version 2.4.2 or later, on any network (mainnet, testnet,
  signet, regtest). The wallet must be on the same network.
- A receive-only NWC code for the wallet you want to receive into
  ([get one here](https://openreceive.org/get_a_nwc_code_to_receive_payments)).
  The code must grant `make_invoice` and `list_transactions` and must not
  advertise any spend method. `lookup_invoice` is optional.
- Optionally, a Lightning Swap Connect (LSC) code from a
  [swap provider](https://openreceive.org/set_up_swap_provider), if payers
  should be able to pay with USDT, USDC, ETH or SOL.

## 2. Install the plugin

In BTCPay, open **Server Settings → Plugins**, search the plugin directory
for **OpenReceive**, click **Install**, and restart BTCPay when prompted.
BTCPay creates the plugin's one table (`openreceive_swaps`, schema
`BTCPayServer.Plugins.OpenReceive`) in its own Postgres at startup; nothing
else is created.

To build the plugin from source instead, follow
[the .NET workspace README](https://github.com/OpenReceive/openreceive/blob/master/packages/dotnet/README.md).

## 3. Connect the wallet

Follow the plugin README's illustrated walkthrough:
[OpenReceive for BTCPay Server](https://github.com/OpenReceive/openreceive/blob/master/packages/dotnet/BTCPayServer.Plugins.OpenReceive/README.md).
It opens the **OpenReceive** page in the store's sidebar, saves the
receive-only NWC code, optionally saves the LSC code to turn swaps on, and
creates a first test invoice. There is nothing else to configure: you never
open BTCPay's Lightning node screen, and the plugin never reads the internal
node.

Saving fails closed if the wallet advertises a spend method such as
`pay_invoice`. Mint a receive-only code instead; the override for a wallet
that cannot is a deliberate, logged choice. Swaps raise the store's invoice
expiration to 60 minutes when it is shorter, because a swap needs at least 45
minutes of invoice life.

## 4. Check it

**Run a health check** on the OpenReceive page runs every probe in place:
the connection, the wallet preflight, payment notifications, the last wallet
scan, the swap provider and its assets, the invoice expiration, and swaps
that need a human. Each failing probe carries a fix link.

Every setting, Greenfield route, swap state, log event and probe is in the
[BTCPay plugin reference](btcpay-reference.md), including what is
unsupported by design: every send-side feature, top-up invoices, and a bare
`nostr+walletconnect://` string in BTCPay's Lightning node screen.

## Next

- [BTCPay plugin reference](btcpay-reference.md) — every setting, route, state, log event and probe
- [Security](security.md) — why receive-only is the only wallet credential
- [Lightning Swap Connect](lightning-swap-connect.md) — what an LSC code is
- [Automated swaps](automated-swaps.md) — the provider states and what turning swaps on commits you to
