# Medusa quickstart

[Medusa](https://medusajs.com) is an open-source commerce platform on Node.
The OpenReceive plugin adds a payment provider to it: the buyer pays at
checkout with Bitcoin over Lightning, straight into your own wallet, and the
order is placed once the payment settles. With a swap provider, the same
checkout also takes USDT, USDC, SOL and ETH, which the provider converts to
BTC over Lightning into the same wallet.

Medusa keeps owning carts, orders, prices and customers. The plugin keeps its
payment attempts in two tables of Medusa's own database, over Medusa's own
connection. Each Medusa payment session is the reference of its payment. When
a payment settles, Medusa's own process-payment workflow captures the session
and completes the cart into an order, whether or not the buyer is still on
the page.

Requirements: Medusa 2 on Node 22.12 or later, and Medusa's PostgreSQL
database. Medusa must run its scheduled jobs, as a Medusa server does unless
you split it into a server and a worker; then the worker runs them.

## Install the plugin

In the Medusa server's project:

```sh
npm install @openreceive/medusa
```

Register the plugin and its payment provider in `medusa-config.ts`, next to
what is already there:

```ts
module.exports = defineConfig({
  projectConfig: {
    // …your existing settings
  },
  plugins: [{ resolve: "@openreceive/medusa", options: {} }],
  modules: [
    {
      resolve: "@medusajs/medusa/payment",
      options: {
        providers: [
          { resolve: "@openreceive/medusa/providers/openreceive", id: "openreceive" },
        ],
      },
    },
  ],
})
```

If `modules` already lists the payment module with other providers, add this
provider to its `providers` list instead of a second entry. Then create the
plugin's two tables and restart Medusa:

```sh
npx medusa db:migrate
```

The plugin mounts the checkout's routes under `/store/openreceive`, where
Medusa checks the publishable API key as on every store route. It adds a job
that runs every minute, and Medusa's id for the provider is
`pp_openreceive_openreceive`.

## Configure the wallet

Put the codes in the Medusa server's `.env`, never in the storefront:

```sh
NWC_URI=nostr+walletconnect://…
LSC_URI_PRIMARY=lightning+swapconnect://…
```

`NWC_URI` is a receive-only Nostr Wallet Connect code: it can create invoices
and read payments but cannot spend, and the plugin refuses a code that can
spend. `LSC_URI_PRIMARY` is optional; leave it out for Bitcoin-only checkout.
Medusa loads `.env` itself. Restart Medusa after changing it.

Then offer the method in your regions: in the admin, open **Settings →
Regions**, edit each region and add **Openreceive (OPENRECEIVE)** to its
payment providers. Or run, in the Medusa server's project:

```sh
npx medusa exec ./node_modules/@openreceive/medusa/dist/enable-openreceive.js
```

It adds the provider to every region and says which ones it changed. Check the
codes and the wallet with:

```sh
npx openreceive doctor
```

`doctor` reads `.env`, prints each code as set or unset (never its value) and
asks the wallet whether it is receive-only. It exits nonzero when a check
fails.

## Add the checkout to the storefront

The buyer pays at the storefront's review step, before the order is placed.
For the [Next.js starter](https://github.com/medusajs/nextjs-starter-medusa),
install the React checkout:

```sh
npm install @openreceive/react
```

Add `src/app/api/openreceive/[...path]/route.ts`. It forwards the checkout's
calls to the Medusa server with the publishable key, as the starter's own
server calls do, and serves the checkout's stylesheet as it is, outside the
starter's Tailwind build:

```ts
import { readFile } from "node:fs/promises"
import path from "node:path"
import { NextRequest } from "next/server"

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL ?? "http://localhost:9000"

async function stylesheet() {
  // Node's own createRequire: Next's bundler would replace an imported one.
  const { createRequire } = await import(/* webpackIgnore: true */ "node:module")
  const resolve = createRequire(path.join(process.cwd(), "package.json")).resolve
  const css = await readFile(resolve("@openreceive/react/styles.css"))
  return new Response(css, {
    headers: { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=3600" },
  })
}

async function forward(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path: segments } = await params
  if (request.method === "GET" && segments.join("/") === "styles.css") return stylesheet()
  const url = new URL(`/store/openreceive/${segments.join("/")}`, BACKEND_URL)
  url.search = request.nextUrl.search
  const response = await fetch(url, {
    method: request.method,
    headers: {
      "content-type": request.headers.get("content-type") ?? "application/json",
      accept: "application/json",
      "x-publishable-api-key": process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? "",
    },
    body: request.method === "GET" ? undefined : await request.text(),
    cache: "no-store",
  })
  const headers = new Headers({ "cache-control": "no-store" })
  for (const name of ["content-type", "retry-after", "x-request-id"]) {
    const value = response.headers.get(name)
    if (value) headers.set(name, value)
  }
  return new Response(await response.text(), { status: response.status, headers })
}

export { forward as GET, forward as POST }
```

In `src/lib/constants.tsx`, name the method and add a test for it:

```tsx
export const paymentInfoMap = {
  // …the existing providers
  pp_openreceive_openreceive: { title: "Bitcoin & stablecoins", icon: <CreditCard /> },
}

export const isOpenReceive = (providerId?: string) =>
  providerId?.startsWith("pp_openreceive_")
```

In `src/modules/checkout/components/payment-button/index.tsx`, show the
checkout for an OpenReceive session and place the order once it settles:

```tsx
import { isManual, isOpenReceive, isStripeLike } from "@lib/constants"
import { Checkout } from "@openreceive/react"

// in PaymentButton's switch, before the manual-payment case:
case isOpenReceive(paymentSession?.provider_id) && !!paymentSession:
  return <OpenReceivePaymentButton notReady={notReady} sessionId={paymentSession!.id} />

const OpenReceivePaymentButton = ({ notReady, sessionId }: { notReady: boolean; sessionId: string }) => {
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  if (notReady) return <Button disabled>Place order</Button>
  return (
    <>
      <link rel="stylesheet" href="/api/openreceive/styles.css" precedence="default" />
      <Checkout
        reference={sessionId}
        prefix="/api/openreceive"
        resumable
        onSettled={() => {
          placeOrder().catch((err) => setErrorMessage(err.message))
        }}
      />
      <ErrorMessage error={errorMessage} data-testid="openreceive-payment-error-message" />
    </>
  )
}
```

The payment step needs no change: it already starts a payment session for
the method the buyer picks.

### Another storefront

Render the checkout where the buyer confirms the order, with the cart's
OpenReceive payment session id as its `reference`: React `<Checkout>`, or the
`<openreceive-checkout>` element from `@openreceive/elements`. When it reports
the payment settled, complete the cart (`POST /store/carts/{id}/complete`).
Its calls go to `/store/openreceive` on the Medusa server with the
publishable key: forward them from your storefront's server as above, or call
Medusa from the browser with a `fetch` that adds the
`x-publishable-api-key` header. A browser call needs the storefront's origin
in Medusa's `STORE_CORS`, as the storefront's own browser calls do; from
another site than Medusa's, the origin must be listed there exactly, not as a
pattern.

## How a payment works

1. The buyer picks "Bitcoin & stablecoins" at the payment step, and Medusa
   starts a payment session with OpenReceive for the cart's total.
2. The review step shows the checkout. It charges the session's amount in the
   cart's currency, converted to sats at the current BTC price. Whoever holds
   the session's id may pay it and follow it, as whoever holds a cart's id may
   complete it in Medusa's own store API.
3. Once the wallet reports the payment, the storefront places the order. Medusa
   refuses to complete the cart before that.
4. The order's payment is captured at once, and its data holds the Lightning
   payment hash.

If the buyer closes the page after paying, the plugin's job finds the payment
within a minute or so, and Medusa's process-payment workflow places the order
anyway. If the cart changes before the buyer pays, Medusa starts a new payment
session, and the checkout asks for the new total.

## Refunds and removal

The receive-only wallet cannot send refunds. A refund made in the Medusa admin
is recorded on the order, as for Medusa's manual payments, and the plugin logs
a warning naming the payment: send that refund from your own wallet. A buyer
whose swap deposit never converted reclaims it from the same checkout while
the cart is still open. If you turn on swaps, keep that path available; see
[swap refunds](swap-refunds.md).

Removing the plugin keeps its two tables: they are a record of payments
received.

## Tested, and not tested

Tested on 2026-10-16 with Medusa 2.21.2 (Medusa's default starter) and
PostgreSQL 17 in Docker, the Next.js starter, a test wallet and a test swap
provider: `db:migrate` with the plugin's tables, the enable script, `doctor`,
and a buyer paying an order by Lightning and by USDT on Solana in Chromium,
after which the order is placed with its payment captured. A payment whose
buyer never placed the order was placed by the plugin's job. An unknown
session, another provider's session and a request without the publishable
key were refused, and an admin refund was recorded. The repository's CI runs
the plugin in a real Medusa 2.21.2 on PostgreSQL on every push: those payments
through the store API, the refusals, the refund and the job.

Tested on 2026-10-19 with the starter's production build (`next build`, then
`next start`): a buyer paid by Lightning and by USDT on Solana as above, and
the route served the checkout's stylesheet, as it also does under
`next dev --turbopack`.

Not tested: Medusa split into a server and a worker, Medusa Cloud, storefronts
other than the Next.js starter, and a storefront calling Medusa from the
browser on another site. Lightning cannot pull a payment, so OpenReceive saves
no payment methods.

## Next

- [Swap refunds](swap-refunds.md)
- [How OpenReceive stores payments](storage.md)
- [Payment safety](payment-safety-upgrade.md)
