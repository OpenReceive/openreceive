This is the full file; follow it from Step 0.

# OpenReceive agent directions (Vendure)

```sh
# READ THIS FIRST: this file is 25 KB and a summary drops required steps. Download it whole:
curl -fsSL https://openreceive.org/agent-directions/vendure/full.md
# Skip the download only if you already have all of it: pasted, read from disk or fetched raw.
```

**Step 0 in brief** (Step 0 below has the details):

- Before installing or editing anything, ask the user for a receive-only NWC code. One question per message.
- Next ask for the LSC code. If the user wants stablecoins, USDT, USDC, ETH, SOL or crypto, do not ask yes/no first.
- The user only pastes codes into this chat. Never ask them to edit .env or run a command to save one.
- Write each code into .env yourself, as Step 0 says. Never echo it or put it in a shell command.
- Do not suggest rotating or revoking a code because it was pasted here.
- Start the quickstart only once the NWC code is saved, and the LSC code is saved or the user said "Bitcoin only".

These directions describe OpenReceive 0.4.29.

Add OpenReceive to the Vendure shop you are working in: a Vendure server with
its worker, and usually a storefront in its own project (Vendure's Next.js
starter or another). OpenReceive is a Vendure plugin on npm,
`@openreceive/vendure`, with a payment method handler. The quickstart
appended to this file has all the code: do not clone the OpenReceive
repository, and do not write your own payment handler, routes or settlement.

The one required credential is a receive-only NWC code (Nostr Wallet Connect):
a string from the merchant's wallet that can create invoices and read their
status, and cannot spend. A swap provider (an "LSC" code) optionally lets
buyers pay with USDT, USDC, ETH or SOL instead; the provider converts the
payment to BTC over Lightning in the merchant's connected wallet. Available
assets and networks depend on the provider.

Vendure keeps orders, prices, customers and fulfillment. The plugin keeps its
payment attempts in two tables of Vendure's database and adds the settled
payment to the order itself once the payment settles, so Vendure places it.
You write no hooks.

## Step 0 — ask for the two codes, one question at a time

Before anything else, check one file: the Vendure server's `.env`.
`grep -E '^(NWC_URI|LSC_URI_PRIMARY)=.' .env | cut -d= -f1` names the codes it
sets without printing them. Check with that, here and after each write, not
by reading the file, and never print the values. A code that is already set is
not asked for again; if both are set, go to Step 1.

Otherwise your next action is a question to the user. Do not install packages,
edit the shop or search anywhere else before asking it. Do not read deploy
config, Docker containers or process environments looking for a code, and
never run `printenv`: a new shop has neither code yet.

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
   `NWC_URI=<paste>` into the Vendure server's `.env` with your file-editing
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

A new Vendure project loads `.env` itself. Under Docker Compose, give the
server, the worker and every other service that runs the Vendure config
`env_file` pointing at that `.env`, and recreate them with
`docker compose up -d`. Do not report setup as complete until the NWC code is
saved, and the LSC code is saved or the user said "Bitcoin only". Never
invent a placeholder code.

## Step 1 — install the plugin in the Vendure server

In the Vendure server's project, run `npm install @openreceive/vendure`, then
add `OpenReceivePlugin` from `@openreceive/vendure/plugin` to the `plugins` in
`src/vendure-config.ts` exactly as the quickstart's "Install the plugin"
shows, keeping every setting already there. The plugin needs Vendure 3.3 or
later, Node 22.12 or later, and PostgreSQL, MySQL or MariaDB; it refuses
SQLite. Restart the server and the worker: the server's startup migrations
create the plugin's two tables, and the worker runs its scheduled task.

Restart them and the storefront the way this project already runs them: in
their own terminal, under Docker Compose with `docker compose up -d --build`,
or by the pid of the process you started. Never `pkill` or `killall` by name:
on a shared machine that stops other people's servers.

## Step 2 — create the payment method and check the wallet

In the Vendure server's project, with the server up (under Docker Compose,
run both inside the server's container with `docker compose exec -T`):

```sh
node node_modules/@openreceive/vendure/dist/enable-openreceive.js
npx openreceive doctor --url http://localhost:3000
```

The first creates the payment method, code `openreceive`, in the default
channel, signing in with `SUPERADMIN_USERNAME` and `SUPERADMIN_PASSWORD` from
the environment; when those are missing, report that and ask the user to
create it in the dashboard (Settings → Payment methods, code `openreceive`,
handler OpenReceive). `doctor` reports each code as set or unset, asks the
wallet whether it is receive-only, and with `--url` (the server's own
address) checks that the plugin's routes answer. It names any failed check
and exits nonzero; fix it before going on. If it reports spend methods such
as `pay_invoice`, remove `NWC_URI` from `.env` and ask the user for a
receive-only code again. Never set the spend-capable override to get past it.

## Step 3 — add the checkout to the storefront

For Vendure's Next.js starter, make the quickstart's storefront changes:
`npm install @openreceive/react`, the route file
`src/app/api/openreceive/[...path]/route.ts`, the server actions in
`src/features/checkout/openreceive.ts`, the checkout in the review step, and
the one-line change to `transitionToArrangingPayment`. Keep the rest of the
storefront as it is. Do not import `@openreceive/react/styles.css` from a
component or a CSS file: the route serves it, outside the starter's Tailwind
build.

For another storefront, follow the quickstart's "Another storefront": `POST
/openreceive/order` with the buyer's session where the buyer confirms, the
checkout with the `reference` it answers, and the checkout's calls sent to
`/openreceive` with the same session.

Rebuild and restart the storefront. Then prove the routes answer through it:

```sh
curl -s -X POST <storefront url>/api/openreceive/checkouts \
  -H 'content-type: application/json' \
  -d '{"reference":"CHECK:USD:100"}'
```

The answer is OpenReceive's JSON refusal, `"code":"FORBIDDEN"`: no session
owns such an order, and the plugin's routes are mounted behind the
storefront's route.

## Step 4 — hand over, then stop

Setup is done when `doctor` is clean and the curl above answers FORBIDDEN.
The browser check is the user's: name it in one line of your closing message,
and do not run it yourself. You cannot pay an invoice: the code is
receive-only. Do not pay, settle or mark an order paid, and do not look for a
way to (a wallet control port, a test endpoint, another wallet, a payment
added through the Admin API).

Your last message starts "Setup is finished" and has at most five short
lines: the storefront's address, "add a product to the cart, check out, pick
Bitcoin & stablecoins at the payment step and place the order: the checkout
appears", and the methods it offers (Bitcoin, plus USDT, USDC, ETH and SOL
when the swap code is saved). Do not mention minimums, never say a coin will
not work, do not list what you changed, and send nothing after it. Do not add
containers, services, workers or cron jobs: the plugin's task runs in
Vendure's own worker.

## Non-negotiables

- Never print, log or commit a code, never put one in a shell argument, and
  never write one into the storefront, source files or browser code.
  `doctor`'s set/unset is all you report.
- Do not suggest rotating, revoking or replacing a code because it was pasted
  into this chat; that is the supported path.
- Work only in this shop's projects. Never read or run anything from another
  project or directory on this machine (its `node_modules`, tools or source),
  for any reason. A browser, Playwright and reading the plugin's source are
  not part of setup: when `doctor`, the enable script or the curl fails,
  report its output.
- Receive-only NWC is required. Never get past the preflight with a code that
  can spend.
- The plugin owns only its two payment tables. Vendure owns orders, prices,
  customers and email. Do not write your own payment handler, routes,
  event subscribers or fulfillment code, and do not change Vendure's own
  packages.
- IF SWAPS ARE ON, KEEP THE ROUTE BACK. A deposit that arrives short or late
  becomes refundable, and the buyer claims it later from the same checkout.
  Keep the plugin installed while swap payments may still need a refund.
  https://openreceive.org/guides/swap-refunds.md
- A receive-only wallet cannot send refunds. A refund made in the Vendure
  dashboard stays pending; the merchant sends it from their own wallet.

## Further reading

- [Vendure Quickstart](https://openreceive.org/guides/quickstart-vendure.md)
- [Automated Swaps](https://openreceive.org/guides/automated-swaps.md)
- [Swap Refunds](https://openreceive.org/guides/swap-refunds.md)
- [Lightning Swap Connect URI](https://openreceive.org/guides/lightning-swap-connect.md)
- [Security](https://openreceive.org/guides/security.md)
- [Price Feeds](https://openreceive.org/guides/price-feeds.md)
- [Payment Safety Upgrade](https://openreceive.org/guides/payment-safety-upgrade.md)

---

## The quickstart, in full

Inlined verbatim so this file needs no network access. Steps 0–4 above are the setup and this is their reference: it has the code they name. Where the two differ, the steps win, and its dashboard screens are only for a shop whose Vendure server has no shell.
The page it comes from is https://openreceive.org/guides/quickstart-vendure.

## Vendure quickstart

[Vendure](https://vendure.io) is an open-source headless commerce platform on
Node. The OpenReceive plugin adds a payment method to it: the buyer pays at
the storefront's checkout with Bitcoin over Lightning, straight into your own
wallet, and Vendure places the order once the payment settles. With a swap
provider, the same checkout also takes USDT, USDC, SOL and ETH, which the
provider converts to BTC over Lightning into the same wallet.

Vendure keeps owning orders, prices, customers and fulfillment. The plugin
keeps its payment attempts in two tables of Vendure's own database, over
Vendure's own connection. When a payment settles, the plugin adds a settled
payment to the order, with the Lightning payment hash as its transaction id,
and Vendure places the order as it does for any payment method: the order
reads PaymentSettled, stock is allocated and Vendure's emails go out.

Requirements: Vendure 3.3 or later on Node 22.12 or later, with PostgreSQL,
MySQL or MariaDB. SQLite and sql.js are not supported: Vendure shares their
one connection with the plugin. The worker must run, with
`DefaultSchedulerPlugin`, as a new Vendure project's does: the plugin's
scheduled task runs there.

### Install the plugin

In the Vendure server's project:

```sh
npm install @openreceive/vendure
```

Add the plugin to `src/vendure-config.ts`, next to what is already there:

```ts
import { OpenReceivePlugin } from "@openreceive/vendure/plugin";

export const config: VendureConfig = {
  // …your existing settings
  plugins: [
    // …your existing plugins
    OpenReceivePlugin,
  ],
};
```

The plugin registers the payment method handler `openreceive`, the
checkout's routes under `/openreceive` on the Vendure server, a scheduled
task that runs every minute on the worker, and a migration for its two
tables. Restart the server and the worker. A new Vendure project runs its
migrations when the server starts (`runMigrations` in `src/index.ts`), which
creates the tables; if yours does not, run its migrations the way it already
does.

### Configure the wallet

Put the codes in the Vendure server's `.env`, never in the storefront:

```sh
NWC_URI=nostr+walletconnect://…
LSC_URI_PRIMARY=lightning+swapconnect://…
```

`NWC_URI` is a receive-only Nostr Wallet Connect code: it can create invoices
and read payments but cannot spend, and the plugin refuses a code that can
spend. `LSC_URI_PRIMARY` is optional; leave it out for Bitcoin-only checkout.
A new Vendure project loads `.env` itself (`import 'dotenv/config'` in
`vendure-config.ts`). Under Docker Compose, give the server and the worker
`env_file: .env`. Restart both after changing it.

Then create the payment method. In the dashboard, open **Settings → Payment
methods**, create one with the code `openreceive` and the handler
**OpenReceive**, and enable it. Or run, in the server's project while the
server is up:

```sh
node node_modules/@openreceive/vendure/dist/enable-openreceive.js
```

It signs in to the Admin API with `SUPERADMIN_USERNAME` and
`SUPERADMIN_PASSWORD` from `.env`, as a new Vendure project has them, and
creates the method in the default channel: "Bitcoin & stablecoins" with a
swap code, "Bitcoin Lightning" without. Run again, it enables the method.
`--admin-api <url>` names another Admin API and `--name "…"` another name.
Check the codes and the wallet with:

```sh
npx openreceive doctor
```

`doctor` reads `.env`, prints each code as set or unset (never its value)
and asks the wallet whether it is receive-only. With
`--url http://localhost:3000` it also checks that the plugin's routes answer.
It exits nonzero when a check fails.

### Add the checkout to the storefront

The buyer pays at the checkout's review step, before the order is placed.
For Vendure's [Next.js starter](https://github.com/vendurehq/nextjs-starter-vendure),
install the React checkout:

```sh
npm install @openreceive/react
```

Add `src/app/api/openreceive/[...path]/route.ts`. It forwards the checkout's
calls to the Vendure server with the buyer's session token, which the starter
keeps in its `vendure-auth-token` cookie, and serves the checkout's
stylesheet as it is, outside the starter's Tailwind build:

```ts
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { NextRequest } from "next/server";
import { getAuthToken } from "@/platform/vendure/auth-token";

const SHOP_API = process.env.VENDURE_SHOP_API_URL || process.env.NEXT_PUBLIC_VENDURE_SHOP_API_URL!;
const CHANNEL =
  process.env.VENDURE_CHANNEL_TOKEN || process.env.NEXT_PUBLIC_VENDURE_CHANNEL_TOKEN || "__default_channel__";

async function stylesheet() {
  const resolve = createRequire(path.join(process.cwd(), "package.json")).resolve;
  const css = await readFile(resolve("@openreceive/react/styles.css"));
  return new Response(css, {
    headers: { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
}

async function forward(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path: segments } = await params;
  if (request.method === "GET" && segments.join("/") === "styles.css") return stylesheet();
  const url = new URL(`/openreceive/${segments.join("/")}`, SHOP_API);
  url.search = request.nextUrl.search;
  const token = await getAuthToken();
  const response = await fetch(url, {
    method: request.method,
    headers: {
      "content-type": request.headers.get("content-type") ?? "application/json",
      accept: "application/json",
      "vendure-token": CHANNEL,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: request.method === "GET" ? undefined : await request.text(),
    cache: "no-store",
  });
  const headers = new Headers({ "cache-control": "no-store" });
  for (const name of ["content-type", "retry-after", "x-request-id"]) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(await response.text(), { status: response.status, headers });
}

export { forward as GET, forward as POST };
```

Add `src/features/checkout/openreceive.ts`, two server actions. The first
asks the plugin to start paying the active order: the plugin moves it to
ArrangingPayment, as Vendure's own checkout does before a payment, and
answers the reference the checkout pays. The second runs once the payment
settled, when the plugin has placed the order:

```ts
"use server";

import { updateTag } from "next/cache";
import { getLocale } from "next-intl/server";
import { redirect } from "@/platform/i18n/navigation";
import { getAuthToken } from "@/platform/vendure/auth-token";

const SHOP_API = process.env.VENDURE_SHOP_API_URL || process.env.NEXT_PUBLIC_VENDURE_SHOP_API_URL!;
const CHANNEL =
  process.env.VENDURE_CHANNEL_TOKEN || process.env.NEXT_PUBLIC_VENDURE_CHANNEL_TOKEN || "__default_channel__";

export async function startOpenReceivePayment(): Promise<{ reference: string; orderCode: string }> {
  const token = await getAuthToken();
  const response = await fetch(new URL("/openreceive/order", SHOP_API), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "vendure-token": CHANNEL,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: "{}",
    cache: "no-store",
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.message ?? `OpenReceive answered ${response.status}`);
  return { reference: body.reference, orderCode: body.order_code };
}

export async function finishOpenReceivePayment(orderCode: string) {
  updateTag("cart");
  updateTag("active-order");
  const locale = await getLocale();
  redirect({ href: `/order-confirmation/${orderCode}`, locale });
}
```

In `src/features/checkout/routes/steps/review-step.tsx`, show the checkout
when the buyer places an order with OpenReceive:

```tsx
import { finishOpenReceivePayment, startOpenReceivePayment } from "../../openreceive";
import { Checkout } from "@openreceive/react";

// The code of the OpenReceive payment method (enable-openreceive.js creates it).
const OPENRECEIVE_METHOD = "openreceive";

// in ReviewStep, beside the existing state:
const [openReceive, setOpenReceive] = useState<{ reference: string; orderCode: string } | null>(null);
const [paymentError, setPaymentError] = useState<string | null>(null);

// first in handlePlaceOrder, after setLoading(true):
if (selectedPaymentMethodCode === OPENRECEIVE_METHOD) {
  // The buyer pays here; the plugin places the order once the payment settles.
  try {
    setOpenReceive(await startOpenReceivePayment());
  } catch (error) {
    setPaymentError(error instanceof Error ? error.message : String(error));
  } finally {
    setLoading(false);
  }
  return;
}

// in place of the Place Order <Button>:
{openReceive ? (
  <>
    <link rel="stylesheet" href="/api/openreceive/styles.css" precedence="default" />
    <Checkout
      reference={openReceive.reference}
      prefix="/api/openreceive"
      resumable
      onSettled={() => {
        void finishOpenReceivePayment(openReceive.orderCode);
      }}
    />
  </>
) : (
  <Button onClick={handlePlaceOrder} /* …as it was */>…</Button>
)}
{paymentError && <p className="text-sm text-destructive text-center">{paymentError}</p>}
```

The order now waits in ArrangingPayment while the buyer pays. In
`src/features/checkout/routes/actions.ts`, let `transitionToArrangingPayment`
accept an order that is already there, so a buyer who opened the Bitcoin
checkout can still pay with another method:

```ts
if (result.data.transitionOrderToState?.__typename === "OrderStateTransitionError") {
  const errorResult = result.data.transitionOrderToState;
  // The OpenReceive checkout already moved it: it is ready to pay another way.
  if (errorResult.fromState === "ArrangingPayment") return;
  throw new Error(/* …as it was */);
}
```

#### Another storefront

Where the buyer confirms the order, `POST /openreceive/order` on the Vendure
server with the buyer's session (the cookie or bearer token the storefront
already sends Vendure, plus `vendure-token` on a channel other than the
default) and an empty JSON body. Render React `<Checkout>`, or the
`<openreceive-checkout>` element from `@openreceive/elements`, with the
`reference` it answers, and send the checkout's calls to `/openreceive` on
the Vendure server with the same session: forward them from your
storefront's server as above, or call Vendure from the browser with a `fetch`
that sends the session. A browser call from another site needs the
storefront's exact origin in Vendure's `apiOptions.cors.origin`; a pattern or
`true` is not enough. When the checkout reports the payment settled, the
order is placed: show its confirmation.

### How a payment works

1. The buyer picks "Bitcoin & stablecoins" at the payment step and places
   the order. The plugin moves the order to ArrangingPayment and answers its
   reference: the order's code, currency and amount due.
2. The checkout charges that amount in the order's currency, converted to
   sats at the current BTC price. Only the buyer's session, or the signed-in
   customer the order belongs to, may pay it. A Shop API call cannot add an
   OpenReceive payment, so a buyer cannot mark an order paid.
3. Once the wallet reports the payment, the plugin adds a settled payment to
   the order, and Vendure places it.
4. The checkout takes the buyer to the order's confirmation.

If the buyer closes the page after paying, the scheduled task finds the
payment within a minute or so and places the order anyway. If the cart
changes before the buyer pays, the amount due changes and so does the
reference: the checkout asks for a new invoice for the new total. Vendure
keeps an order in ArrangingPayment from changing; a storefront that lets the
buyer go back to the cart moves it back with
`transitionOrderToState(state: "AddingItems")`.

### Refunds and removal

The receive-only wallet cannot send refunds. A refund made in the dashboard
stays pending in Vendure, and the plugin logs a warning naming the payment:
send the refund from your own wallet, then settle the refund in the
dashboard. A buyer whose swap deposit never converted reclaims it from the
same checkout, with the same session, while the order is still unpaid. If you
turn on swaps, keep that path available; see
[swap refunds](https://openreceive.org/guides/swap-refunds.md).

Removing the plugin keeps its two tables: they are a record of payments
received.

### Tested, and not tested

Tested on 2026-10-19 with Vendure 3.8.0 on PostgreSQL 17 in Docker, its
worker and the Next.js starter, a test wallet and a test swap provider: the
migration, the enable script, `doctor`, and a guest paying an order by
Lightning and by USDT on Solana in Chromium, after which the order reads
PaymentSettled with the payment hash as its transaction id. A payment whose
buyer left was placed by the scheduled task. Another guest, a visitor with no
session, a changed amount and the Shop API's `addPaymentToOrder` were
refused, a reload resumed the same invoice, and a buyer who opened the
Bitcoin checkout then paid with Vendure's test method. CI runs the plugin
against a Vendure 3.8 server and PostgreSQL.

Not tested: MySQL and MariaDB, more than one channel, Vendure's other
storefront starters, and a storefront calling Vendure from the browser on
another site. Lightning cannot pull a payment, so OpenReceive saves no
payment methods.
