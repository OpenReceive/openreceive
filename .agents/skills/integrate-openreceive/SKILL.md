---
name: integrate-openreceive
description: >
  Integrate OpenReceive Bitcoin Lightning checkout and optional USDT, USDC,
  SOL, and ETH swaps. Use for Node.js, Express, Fastify, Next.js, Rails,
  Python, Django, FastAPI, Laravel, plain PHP, WordPress/WooCommerce,
  React, Vue, Svelte, Angular, or plain HTML applications, or connecting
  BTCPay Server to a receive-only NWC wallet. A configured swap provider
  converts these payments to BTC over Lightning in the merchant's connected
  wallet; asset and network availability depends on the provider.
license: MIT
---

# Integrate OpenReceive

OpenReceive is a payment library that runs inside the application you are
editing. It mounts HTTP routes there, issues Lightning invoices against a
wallet the merchant already controls, and calls back into your code when one
settles. There is no OpenReceive account and no API key; funds land directly in
the merchant's wallet. The one required credential is a **receive-only NWC
code** (`NWC_URI`).

Optional swaps let customers pay with USDT, USDC, SOL, and ETH. A configured
swap provider converts these payments to BTC over Lightning in the merchant's
connected wallet; asset and network availability depends on the provider.

## Pick the stack, then follow its directions

1. Identify the server stack of the application you are in.
2. Open the matching reference — it is complete (quickstart inlined) and needs
   no network access:
   - Node, Express: [references/node.md](references/node.md)
   - Node, Fastify: [references/fastify.md](references/fastify.md)
   - Node, Next.js App Router: [references/next.md](references/next.md)
   - Rails: [references/rails.md](references/rails.md)
   - Python, FastAPI: [references/fastapi.md](references/fastapi.md)
   - Plain PHP: [references/php.md](references/php.md)
   - Django: [references/django.md](references/django.md)
   - Laravel: [references/laravel.md](references/laravel.md)
   - WordPress + WooCommerce: [references/woocommerce.md](references/woocommerce.md) — the packaged gateway and merchant settings.
   - BTCPay Server: [references/btcpay.md](references/btcpay.md) — a plugin,
     configured in BTCPay's store UI or Greenfield API; no application code,
     no npm packages, no gem. The rest of this file is about the library.
3. Follow its **Step 0** first: before writing code or searching the machine,
   ask the user for the receive-only NWC code (then the swap URI), one question
   per message, and store each pasted code in the project's env file yourself.
   Never print the value; never invent a placeholder.

Install, per adapter — Express: `npm install @openreceive/express @openreceive/react`;
Fastify: `npm install @openreceive/fastify @openreceive/react`; Next.js:
`npm install @openreceive/next @openreceive/react`. Swap the UI package (`vue`,
`svelte`, `angular`, `elements`) for the frontend the app already has. Install
(Rails): `bundle add openreceive-rails`.
Django: `pip install "openreceive[django]"`; FastAPI:
`pip install "openreceive[fastapi]"`; Laravel: `composer require openreceive/laravel`;
plain PHP: `composer require openreceive/openreceive nyholm/psr7 nyholm/psr7-server`.

## The three server objects

| Object | Built with | Talks to |
| --- | --- | --- |
| Wallet client | `createOpenReceive()` | the merchant's wallet — mints invoices, reads settlement, holds the NWC code |
| Host | `createHost()` | your database — your hooks plus the `openreceive_payments` table |
| HTTP routes | `openReceiveExpress()` / `openReceiveFastify()` / `openReceiveNext()` / the Rails engine | the browser — mounted at `/openreceive` by default |

The quickstart's one-factory form (`openReceiveExpress({ wallet, storage,
amountFor, authorize })`) builds all three; compose them separately only for a
shared wallet client or a custom repository. The checkout UI
(`<Checkout reference={...} prefix="/openreceive" />`) is the optional fourth
piece.

## The host contract: authorize, amountFor, onPaid

Your application keeps orders, users, prices, and fulfillment. Three hooks are
the entire bridge — wire them to the models this app already has, never to
copied demo models:

- `amountFor(reference)` — the authoritative price, read from your own data.
  Return `{ currency, value, description }` with `value` a **decimal string**
  (never a float, never payer input), or `null` when there is nothing to pay
  for. The `reference` is your order id: one per thing you fulfill, created
  before checkout, kept across retries, never reused.
- `authorize({ action, request, resource })` — your own access check, run on
  every request. `resource.reference` is a claim the payer made, not proof;
  read a real session.
- `onPaid({ reference, paidAt, query })` — fulfillment, run once per reference
  inside the settlement transaction, only for the first settled attempt. Use
  the provided `query`, not your ORM's other connection, and guard the
  transition (`UPDATE … WHERE state = 'awaiting_payment'`).

## 409 is a state, not a failure

The library serializes attempts per reference. A create that returns **409
CONFLICT** is normal checkout flow: the reference already settled, or an unpaid
checkout for that payment method is already in progress. Surface it as order
state; do not retry-loop it, and do not build an idempotency store around it —
that serialization is the library's job. (A hook failure while persisting an
attempt is a **503 retryable**, deliberately distinct.)

## Amounts on the deposit panel

`swap.deposit_amount` is the ONLY amount a payer is ever told to send, in the
pay-in token. `swap.fee.pay_in_fiat` / `payout_fiat` are fiat valuations that
explain the spread (why the deposit exceeds the cart total); they are not
instructions. For a stablecoin pegged to the fee currency (USDT, USDC) the
packaged checkout expresses the breakdown in the token and never renders
`pay_in_fiat` — "$50.03" under "50.05 USDC" reads as the same number with a
typo. A custom UI gets the same rule from `createSwapFeeBreakdown(fee, swap)`;
pass the swap, not just the fee.

## Secrets

`NWC_URI` and `LSC_URI_*` are server-only. Never put them in browser code,
logs, assets, or tests. Boot fails closed if the NWC code advertises spend
methods such as `pay_invoice` — mint a receive-only code
(https://openreceive.org/get_a_nwc_code_to_receive_payments) instead of
overriding.

## Database tables

Generate the two tables in the host's existing database:

| Stack | Generate and apply |
| --- | --- |
| Node | `npx openreceive scaffold payments --orm <orm>`, then the app's normal migration command |
| Rails | `bin/rails generate openreceive:install && bin/rails db:migrate` |
| Django | `manage.py openreceive_install <app> && manage.py migrate` |
| FastAPI | `openreceive scaffold payments --alembic --dialect <db>` (or `--sql`), then apply through the app's migration workflow |
| Laravel | `php artisan openreceive:install && php artisan migrate` |
| Plain PHP | Use `OpenReceive\Storage\PaymentsSchema::statements($dialect)` in the host's migration workflow, as in the PHP reference |

These emit `openreceive_payments` + `openreceive_meta`. The tables sit beside
your models — no relations to them, no separate database, no Redis. WordPress
and BTCPay manage installation through their plugins; follow their references.

## Verify, and test without a real wallet

| Stack | Doctor | Test seam |
| --- | --- | --- |
| Node | `npx openreceive doctor` | `client` on `createOpenReceive` (`preflight`, `makeInvoice`, `listTransactions`), plus `StaticPriceProvider` |
| Rails | `bin/rails openreceive:doctor` | `config.nwc_client`, `config.swap_providers`, `config.price_provider` |
| Django | `manage.py openreceive_doctor` | `OPENRECEIVE["SERVICE"]`, a factory returning a `Service` built on `openreceive.testing` fakes |
| FastAPI | `openreceive doctor --app main:app` | `nwc_client`, `price_provider`, `swap_providers` on `openreceive_router`, using `openreceive.testing` fakes |
| Laravel | `php artisan openreceive:doctor` | Bind `ReceiveNwcClient`, `PriceProvider`, and `OpenReceiveServiceProvider::SWAP_PROVIDERS` in the container |
| Plain PHP | `php bin/doctor` (host script calling `$engine->doctor()`) | Build `Service` with `OpenReceive\Testing\FakeWallet`, `FakeSwapProvider`, and `OpenReceive\Rates\StaticPriceProvider` |
| WordPress | `wp openreceive doctor`, then `wp openreceive test-invoice <order id>` for a real invoice | Repository development: the documented Docker `compose.testkit.yml` override |
| BTCPay | Follow the plugin reference's connection and checkout checks | Use the plugin's Docker test setup in its reference |

The routes, persistence, reconciliation, and fulfillment hooks then run the
production paths. Details: https://openreceive.org/guides/host-testing.md

## Deeper documentation

Fetch on demand — each URL is raw markdown:
https://openreceive.org/guides/authorization.md ·
https://openreceive.org/guides/storage.md ·
https://openreceive.org/guides/api-reference.md ·
https://openreceive.org/guides/security.md ·
https://openreceive.org/openapi.yaml (the normative HTTP contract) ·
https://openreceive.org/llms.txt (the full index)
