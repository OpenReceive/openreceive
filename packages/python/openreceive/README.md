# OpenReceive for Python

[OpenReceive](https://openreceive.org) adds Bitcoin and crypto checkout to your
Python application. Accept **BTC over Lightning** directly into your wallet,
and optionally let customers pay with **USDT, USDC, ETH or SOL** through a
configured swap provider. You receive **BTC over Lightning** in either case.

Your application keeps its orders, prices, customers and fulfillment.
OpenReceive connects checkout to your wallet, records payment attempts in your
existing database, and tells your application when a payment has settled.
There is no OpenReceive account to create and no separate database to operate.

[Website](https://openreceive.org) ·
[Django quickstart](https://openreceive.org/guides/quickstart-django) ·
[FastAPI quickstart](https://openreceive.org/guides/quickstart-fastapi) ·
[All guides](https://openreceive.org/guides)

## How payments work

1. **Your server sets the price.** OpenReceive creates a Lightning invoice in
   your connected wallet for the amount your application supplies.
2. **The customer chooses how to pay.** They can pay the invoice directly with
   a Lightning wallet. With swaps enabled, they can instead send a supported
   asset, such as USDT or USDC, to the swap provider. The provider converts it
   and pays your Lightning invoice.
3. **Your wallet confirms receipt.** OpenReceive records settlement and runs
   your application's payment hook. A swap provider saying it has finished
   does not count as payment: your wallet must confirm the invoice settled.

Available swap assets, networks, limits and fees depend on the configured
provider. Swaps are optional; Lightning checkout works without them. See
[how swaps work](https://openreceive.org/guides/automated-swaps),
[provider setup](https://openreceive.org/set_up_swap_provider), and
[payer swap refunds](https://openreceive.org/guides/swap-refunds).

## Designed for receive-only wallet access

OpenReceive connects through **Nostr Wallet Connect (NWC)**, using a connection
code issued by your wallet. It does not need your wallet's seed phrase.

- **No spending permission required.** A receive-only connection can create
  invoices and read payments, but cannot send funds. By default, OpenReceive
  refuses a connection that advertises spending methods. Bypassing that check
  requires an explicit override.
- **Credentials stay on your server.** Neither the NWC code nor swap-provider
  credentials belong in browser code, logs or tests. A receive-only code is
  still sensitive: it can expose payment history and allow invoice creation.
- **Your application controls access and prices.** Order authorization and
  amounts come from your server, not from the payer's browser.
- **Payments survive retries.** Persistent attempts, per-order locking and
  write-once settlement prevent repeated payment checks from running the
  payment hook again for the same order.

OpenReceive does not hold your funds. Your chosen wallet determines custody;
when using swaps, the provider handles the customer's deposit until payout or
refund. Receive-only access limits what the integration can do, while your
wallet, provider and server remain part of the trust model. Read the
[security guide](https://openreceive.org/guides/security).

## Install

Requires **Python 3.10 or newer**. Choose the extra for your application:

```sh
# Django 5.2 or newer
pip install "openreceive[django]"

# FastAPI 0.115 or newer, with SQLAlchemy 2
pip install "openreceive[fastapi]"

# Other Python applications using SQLAlchemy 2
pip install "openreceive[sqlalchemy]"
```

Start with the [Django quickstart](https://openreceive.org/guides/quickstart-django)
or [FastAPI quickstart](https://openreceive.org/guides/quickstart-fastapi).
There is also a [Flask recipe](https://openreceive.org/guides/flask-recipe).
Django includes the checkout's browser assets; FastAPI and other hosts can use
OpenReceive's [frontend components](https://openreceive.org/guides/frontend-checkout).
The SQLAlchemy integration uses a synchronous engine for the payment tables.

## Connect your application

Get a [receive-only wallet connection](https://openreceive.org/get_a_nwc_code_to_receive_payments)
and set `NWC_URI` in your server's process environment. To enable swaps, also
configure `LSC_URI_PRIMARY` and optionally `LSC_URI_BACKUP` using the
[provider setup guide](https://openreceive.org/set_up_swap_provider).

Your host supplies authorization, the order amount, a payment hook and its
existing database connection. OpenReceive manages `openreceive_payments` and
`openreceive_meta` in that database; your application applies their migrations
through its normal workflow. Checkout requests drive reconciliation through a
shared database gate, with an optional separate notifications worker.

- [Payment storage and migrations](https://openreceive.org/guides/storage)
- [Authorization and host responsibilities](https://openreceive.org/guides/authorization)
- [Environment variables](https://openreceive.org/guides/environment-variables)
- [Testing with fake wallets and swap providers](https://openreceive.org/guides/host-testing)
- [Deployment](https://openreceive.org/guides/deploying)

OpenReceive is open source under the MIT license.
[Source code](https://github.com/OpenReceive/openreceive) ·
[Report an issue](https://github.com/OpenReceive/openreceive/issues)
