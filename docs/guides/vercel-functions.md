# Bitcoin checkout on Vercel Functions

For a site on Vercel with no framework: static HTML pages, and JavaScript
functions under `api/`. OpenReceive runs inside one of your own functions.
It creates each Lightning invoice with your wallet, the payment goes straight
to that wallet, and payment attempts are stored in your Postgres database.
There is no OpenReceive account, no API key and no background worker.

Optional swaps let customers pay with **USDT, USDC, SOL, and ETH**. A swap
provider you configure converts the payment to **BTC over Lightning**, and it
settles into the same wallet. Available assets and networks depend on the
provider.

Use `@openreceive/*` 0.5.0 or newer. A Next.js app on Vercel is covered in
[Vercel and v0](vercel.md) instead.

## Before you start

- A receive-only NWC code from your Lightning wallet
  ([get one](https://openreceive.org/get_a_nwc_code_to_receive_payments)).
  It can create invoices and read payments, but it cannot spend.
- Optional: a swap provider code, for USDT, USDC, SOL and ETH
  ([set one up](https://openreceive.org/set_up_swap_provider)).
- **A Postgres database.** Every instance of a function has to see the same
  payment rows, so SQLite, a KV store and Redis cannot hold them. If the
  project has no Postgres, open its **Storage** tab, add **Neon** and connect
  it to all three environments. The free plan is enough. Neon adds
  `DATABASE_URL`, a pooled URL for the app, and `DATABASE_URL_UNPOOLED`, a
  direct URL for creating tables.

Add the codes under the project's **Settings** → **Environment Variables** →
**Add Environment Variable**: `NWC_URI`, and `LSC_URI_PRIMARY` for swaps.
Keep the type **Secret** and tick **Production**, **Preview** and
**Development**. Keep the codes out of your chat with the agent: it never
needs to see them. A variable reaches the deployments made after you add it,
so redeploy once they are in.

OpenReceive adds two tables of its own, `openreceive_payments` and
`openreceive_meta`. It never stores your orders: it reads each order's price
through a function your code provides, and marks the order paid through
another. If your orders live somewhere else, such as Stripe, Airtable, a JSON
file or a KV store, they can stay there. Only the payment rows need Postgres.

Vercel's free Hobby plan is fine for a demo. It is for personal,
non-commercial use only, and taking payments from visitors counts as
commercial under Vercel's
[fair use guidelines](https://vercel.com/docs/limits/fair-use-guidelines).
A shop that sells for real needs a Pro plan.

## Start from the starter

The [Vercel Functions starter](https://github.com/OpenReceive/openreceive/tree/master/examples/vercel-functions-starter)
is a one-product shop with checkout already wired: a static page, the payment
function, the rewrite and the order page. Click **Deploy** in its README.
Vercel copies it into a new GitHub repository, adds a Neon database when you
click **Add** next to Neon, and asks for `NWC_URI`. The first build creates
the tables.

## Add checkout with a coding agent

Once the codes and the database are in the project, give your coding agent
(Cursor, Claude Code, Codex or another) this prompt:

<!-- platform-prompt:begin -->
```text
Add Bitcoin Lightning checkout to this site with OpenReceive. Download the directions with your terminal and follow them exactly:

curl -fsSL https://openreceive.org/agent-directions/vercel-functions/full.md

NWC_URI and LSC_URI_PRIMARY are already set as this project's environment variables in Vercel, so do not ask me for them. Store payments in the Neon database: a pg Pool on DATABASE_URL for the app, and DATABASE_URL_UNPOOLED to create the tables. Use @openreceive packages 0.5.0 or newer.
```
<!-- platform-prompt:end -->

Bitcoin only, with no swap provider? Then in the prompt, replace
`NWC_URI and LSC_URI_PRIMARY are already set` with
`I want Bitcoin only, with no swaps. NWC_URI is already set`.

The directions tell the agent which function to write, how to map its three
hooks onto your orders, and how to put the checkout on your order page.

## Add it by hand

The [Vercel Functions recipe](../recipes/vercel-functions.md) has every file:
the function, the rewrite in `vercel.json`, the table script, a signed guest
cookie and the checkout element for a plain HTML page.

## Check it

Deploy, then ask for a real order as a stranger, with no cookie:

```sh
curl -s -X POST https://<your-deployment>/openreceive/checkouts/prepare \
  -H 'content-type: application/json' -d '{"reference":"<a real order id>"}'
```

It must answer `403` with OpenReceive's JSON, `"code":"FORBIDDEN"`. Vercel's
`NOT_FOUND` page means the rewrite is missing, and `WALLET_UNAVAILABLE` means
the deployment has no `NWC_URI`: add it, then redeploy. A preview behind
Vercel Authentication answers `401` to `curl`; try that one in the browser
where you are signed in to Vercel, or use the production domain.

Then place an order as a buyer and open its page. You should see the payment
methods and, after you pick Bitcoin, a Lightning invoice in sats. Each swap
has a minimum amount set by the provider, so on a small order some coins are
greyed out and show their minimum. Pay a small order from your wallet to see
it settle: the checkout shows the payment as received, and your code marks
the order paid.

## How it runs on Vercel

We measured these on a Vercel deployment with Fluid compute and Node 24.

- **One function, one rewrite.** Every payment route sits under
  `/openreceive/`, and the rewrite `/openreceive/:path*` → `/api/openreceive`
  sends them all to `api/openreceive.js`. The function still sees the path
  the browser asked for. Outside Next.js, a file named
  `api/openreceive/[...path].js` matches only one path segment, so it cannot
  serve `/openreceive/checkouts/prepare`.
- **The stack is built on the first request.** OpenReceive connects to your
  wallet as soon as its stack is built, and Vercel can load a function well
  before a request arrives. A stack built when the file loaded answered the
  first request on a fresh instance with a 503. Built on the first request
  and kept for the next ones, it answered every time, also after idle gaps.
- **No worker or cron job required.** Each request to the payment routes also
  checks the wallet for settled invoices, through a lock in your database. A
  payer who closes the tab is settled on the next request from anyone.
  On a quiet site that can be hours later. If fulfillment should not wait,
  see [When the payer leaves the page](deploying.md#when-the-payer-leaves-the-page).
- **Node, with time to spare.** The function runs on Node, never the Edge
  runtime. `maxDuration: 30` in `vercel.json` covers a slow wallet relay; a
  checkout request took 0.1 to 1.6 seconds in our test.
- **The payer's address.** Vercel replaces any `x-forwarded-for` a client
  sends, so its first address is the payer's, and the per-IP limit on new
  invoices counts each payer.
- **Pages in `public/`.** With no `public/` folder, Vercel serves every file
  in the project's root, including server code in `lib/`. The codes stay in
  environment variables either way.
- **Keep order pages reachable.** A payer with a swap in progress comes back
  to the order's page to claim a refund, sometimes hours later, so its URL
  and the buyer's cookie must still work then. See
  [swap refunds](swap-refunds.md).

## What we test

- **The recipe's code, on every CI run.** The function, the guest cookie, the
  function that keeps a swap's hash and the table script are taken from the
  recipe as written and served the way a Vercel deployment routes and runs
  them, as two instances on one Postgres behind PgBouncer in transaction mode,
  with a test wallet. A buyer gets an invoice, a stranger is refused,
  concurrent requests leave one live invoice, and a paid invoice marks the
  order paid once.
- **A real deployment.** On 2026-11-19 the same function on Vercel, with a
  Neon database and a test wallet on a public relay, did all of that live,
  and the measurements above come from it.
- **Coding agents.** On 2026-11-19 Codex and Cursor added OpenReceive 0.5.0
  to a plain shop like this one from the prompt above, three times in a row.
  Each shop was deployed to Vercel, where it issued a real invoice and
  refused a stranger. See [how we test platforms](how-we-test-platforms.md).

More detail: [Vercel Functions recipe](../recipes/vercel-functions.md),
[Bitcoin checkout on serverless hosts](serverless.md),
[Payment storage](storage.md), [Security](security.md).
