# OpenReceive agent directions (Medusa)

Add OpenReceive to the Medusa store you are working in: a Medusa server, and
usually a storefront in its own project (Medusa's Next.js starter or another).
OpenReceive is a Medusa plugin on npm, `@openreceive/medusa`, with a payment
provider. The quickstart appended to this file has all the code: do not clone
the OpenReceive repository, and do not write your own payment provider, routes
or settlement.

The one required credential is a receive-only NWC code (Nostr Wallet Connect):
a string from the merchant's wallet that can create invoices and read their
status, and cannot spend. A swap provider (an "LSC" code) optionally lets
buyers pay with USDT, USDC, ETH or SOL instead; the provider converts the
payment to BTC over Lightning in the merchant's connected wallet. Available
assets and networks depend on the provider.

Medusa keeps carts, orders, prices and customers. The plugin keeps its payment
attempts in two tables of Medusa's database and places the order through
Medusa's own workflow once the payment settles. You write no hooks.

## Step 0 — ask for the two codes, one question at a time

Before anything else, check one file: the Medusa server's `.env`.
`grep -E '^(NWC_URI|LSC_URI_PRIMARY)=.' .env | cut -d= -f1` names the codes it
sets without printing them. Check with that, here and after each write, not
by reading the file, and never print the values. A code that is already set is
not asked for again; if both are set, go to Step 1.

Otherwise your next action is a question to the user. Do not install packages,
edit the store or search anywhere else before asking it. Do not read deploy
config, Docker containers or process environments looking for a code, and
never run `printenv`: a new store has neither code yet.

The user never edits an environment file. They paste each code
into this chat; you store it. That is the supported path: do not ask them to
save it themselves, and do not tell them to revoke or replace a
code because it was pasted here. Ask one question per message.

1. **First message — the NWC code, and nothing else.**

   > To receive payments I need a receive-only wallet code. In Rizful: open
   > the menu, tap NWC, choose Receive-only NWC code, and tap Copy
   > (https://openreceive.org/get_a_nwc_code_to_receive_payments). If you would
   > rather run your own wallet, Alby Hub works too: Connections → Add
   > Connection → Read Only. Paste the code here and I will store it.

2. **When they paste it.** If it does not start with `nostr+walletconnect://`,
   ask them to copy the receive-only code again. Otherwise write
   `NWC_URI=<paste>` into the Medusa server's `.env` with your file-editing
   tool. Never write it with a shell command (`echo`, `printf`, a heredoc): the
   command line shows the code. Never put it in the storefront, in a
   `NEXT_PUBLIC_` variable or in a commit. Reply only that it is saved, then
   ask the next question.
3. **Second message — swaps.** If the user asked for stablecoins, USDT, USDC,
   ETH, SOL, altcoins or "crypto" (as in "Bitcoin and stablecoin payments"),
   this message IS the walkthrough below: do not skip it, and do not ask yes
   or no first. Otherwise ask whether buyers should also be able to pay with
   USDT, USDC, ETH or SOL, then give the walkthrough. The walkthrough:

   > Go to https://lightning-swap.com, sign in for API keys, create a key, and
   > copy the whole URI (https://openreceive.org/set_up_swap_provider). Paste
   > it here and I will store it — or say "Bitcoin only" and I will continue
   > without it.

   Mention FixedFloat only if they already use it.
4. **When they paste it.** If it does not start with
   `lightning+swapconnect://`, ask them to copy it again. Otherwise add
   `LSC_URI_PRIMARY=<paste>` to the same `.env` with the file-editing tool.
   Swaps are now on, so keep the route back (the swap non-negotiable below).

Medusa loads `.env` itself. Under Docker Compose, give the Medusa service
`env_file: .env` and recreate it with `docker compose up -d`. Do not report
setup as complete until the NWC code is saved, and the LSC code is saved or
the user said "Bitcoin only". Never invent a placeholder code.

## Step 1 — install the plugin in the Medusa server

In the Medusa server's project, run `npm install @openreceive/medusa`, then
register the plugin and its payment provider in `medusa-config.ts` exactly as
the quickstart's "Install the plugin" shows, keeping every setting already
there. If the payment module is already configured, add the provider to its
`providers` list. Run `npx medusa db:migrate`, which creates the plugin's two
tables, and restart Medusa. Medusa needs Node 22.12 or later for the plugin.

Restart Medusa and the storefront the way this project already runs them: in
their own terminal, under Docker Compose with `docker compose up -d`, or by
the pid of the process you started. Never `pkill` or `killall` by name: on a
shared machine that stops other people's servers.

## Step 2 — offer it in the regions and check the wallet

In the Medusa server's project:

```sh
npx medusa exec ./node_modules/@openreceive/medusa/dist/enable-openreceive.js
npx openreceive doctor
```

The first adds OpenReceive to every region. `doctor` reads `.env`, reports
each code as set or unset, and asks the wallet whether it is receive-only. It
names any failed check and exits nonzero; fix it before going on. If it
reports spend methods such as `pay_invoice`, remove `NWC_URI` from `.env` and
ask the user for a receive-only code again. Never set the spend-capable
override to get past it.

## Step 3 — add the checkout to the storefront

For Medusa's Next.js starter, make the quickstart's storefront changes:
`npm install @openreceive/react`, the route file
`src/app/api/openreceive/[...path]/route.ts`, the method in
`src/lib/constants.tsx`, and the `OpenReceivePaymentButton` in the payment
button. Keep the rest of the storefront as it is. Do not import
`@openreceive/react/styles.css` from a component or a CSS file: the starter's
Tailwind build refuses it, which is why the route serves it.

For another storefront, follow the quickstart's "Another storefront": the
checkout at the step where the buyer confirms, with the OpenReceive payment
session's id as `reference`, and the cart completed when it reports settled.

Restart the storefront. Then prove the plugin answers on the Medusa server:

```sh
curl -s -X POST <medusa url>/store/openreceive/checkouts \
  -H 'content-type: application/json' \
  -H 'x-publishable-api-key: <the storefront publishable key>' \
  -d '{"reference":"payses_check"}'
```

The answer is OpenReceive's JSON refusal, `"code":"FORBIDDEN"`: no such
session exists, and the plugin's routes are mounted. The publishable key is
public; it is the storefront's `NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY`.

## Step 4 — hand over, then stop

Setup is done when `doctor` is clean and the curl above answers FORBIDDEN.
The browser check is the user's: name it in one line of your closing message,
and do not run it yourself. You cannot pay an invoice: the code is
receive-only. Do not pay, settle or mark an order paid, and do not look for a
way to (a wallet control port, a test endpoint, another wallet).

Your last message starts "Setup is finished" and has at most five short
lines: the storefront's address, "add a product to the cart, check out, and
pick Bitcoin & stablecoins at the payment step: the review step shows the
checkout", and the methods it offers (Bitcoin, plus USDT, USDC, ETH and SOL
when the swap code is saved). Do not mention minimums, never say a coin will
not work, do not list what you changed, and send nothing after it. Do not add
containers, services, workers or cron jobs: the plugin's job runs inside
Medusa.

## Non-negotiables

- Never print, log or commit a code, never put one in a shell argument, and
  never write one into the storefront, source files or browser code.
  `doctor`'s set/unset is all you report.
- Do not suggest rotating, revoking or replacing a code because it was pasted
  into this chat; that is the supported path.
- Work only in this store's projects. Never read or run anything from another
  project or directory on this machine (its `node_modules`, tools or source),
  for any reason. A browser, Playwright and reading the plugin's source are
  not part of setup: when `doctor`, `db:migrate` or the curl fails, report its
  output.
- Receive-only NWC is required. Never get past the preflight with a code that
  can spend.
- The plugin owns only its two payment tables. Medusa owns carts, orders,
  prices, customers and email. Do not write your own payment provider,
  routes, subscribers or fulfillment code, and do not change Medusa's own
  packages.
- IF SWAPS ARE ON, KEEP THE ROUTE BACK. A deposit that arrives short or late
  becomes refundable, and the buyer claims it later from the same checkout.
  Keep the plugin installed while swap payments may still need a refund.
  https://openreceive.org/guides/swap-refunds.md
- A receive-only wallet cannot send refunds. A refund made in the Medusa admin
  is recorded only; the merchant sends it from their own wallet.

## Further reading

- [Medusa Quickstart](https://openreceive.org/guides/quickstart-medusa.md)
- [Automated Swaps](https://openreceive.org/guides/automated-swaps.md)
- [Swap Refunds](https://openreceive.org/guides/swap-refunds.md)
- [Lightning Swap Connect URI](https://openreceive.org/guides/lightning-swap-connect.md)
- [Security](https://openreceive.org/guides/security.md)
- [Price Feeds](https://openreceive.org/guides/price-feeds.md)
- [Payment Safety Upgrade](https://openreceive.org/guides/payment-safety-upgrade.md)
