# Vendure quickstart

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

## Install the plugin

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

## Configure the wallet

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

## Add the checkout to the storefront

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

### Another storefront

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

## How a payment works

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

## Refunds and removal

The receive-only wallet cannot send refunds. A refund made in the dashboard
stays pending in Vendure, and the plugin logs a warning naming the payment:
send the refund from your own wallet, then settle the refund in the
dashboard. A buyer whose swap deposit never converted reclaims it from the
same checkout, with the same session, while the order is still unpaid. If you
turn on swaps, keep that path available; see
[swap refunds](swap-refunds.md).

Removing the plugin keeps its two tables: they are a record of payments
received.

## Tested, and not tested

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

## Next

- [Swap refunds](swap-refunds.md)
- [How OpenReceive stores payments](storage.md)
- [Payment safety](payment-safety-upgrade.md)
