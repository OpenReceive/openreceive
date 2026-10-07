# Bitcoin checkout on Vercel and v0

v0 builds Next.js apps that run on Vercel, and OpenReceive's Next.js package
runs in them as is. Your app's own server code creates each Lightning invoice,
the payment goes straight to your wallet, and payment attempts are stored in
your app's Postgres database. There is no OpenReceive account, no API key and
no background worker.

Optional swaps let customers pay with **USDT, USDC, SOL, and ETH**. A swap
provider you configure converts the payment to **BTC over Lightning**, and it
settles into the same wallet. Available assets and networks depend on the
provider.

Use `@openreceive/*` 0.4.19 or newer. Earlier versions cannot reach the wallet
from a Next.js 16 production build.

## Before you start

- A receive-only NWC code from your Lightning wallet
  ([get one](https://openreceive.org/get_a_nwc_code_to_receive_payments)).
  It can create invoices and read payments, but it cannot spend.
- Optional: a swap provider code, for USDT, USDC, SOL and ETH
  ([set one up](https://openreceive.org/set_up_swap_provider)).

Put both in the project's environment variables, never in the chat. In v0,
open **Project menu** `...` → **Settings** → **Environment Variables** and add
`NWC_URI` (and `LSC_URI_PRIMARY`) for **Development**, **Preview** and
**Production**. The v0 preview only sees Development variables, so a code set
only for Production leaves the preview's checkout unavailable.

## Start from the starter

The [Next.js + Postgres starter](https://github.com/OpenReceive/openreceive/tree/master/examples/next-postgres-starter)
is a one-product shop with checkout already wired.

1. Click **Deploy** in its README. Vercel copies the starter into a new GitHub
   repository, creates a Neon database and asks for `NWC_URI`. The first build
   creates the tables.
2. In v0, start a new chat, open the **+** menu, choose **Import from…** →
   **Import from GitHub**, and pick the new repository. v0 connects the chat to
   the Vercel project, so the preview gets the database and the environment
   variables.
3. Add `NWC_URI` for **Development** as described above.
4. Ask v0 for the shop you want: products, pages, design. Keep the payment
   route's three hooks, `authorize`, `amountFor` and `onPaid`, pointed at
   your orders.

## Add checkout to an existing v0 app

1. Connect a database: **Project menu** `...` → **Settings** →
   **Integrations**, then Neon. It adds `DATABASE_URL`, a pooled URL for the
   app, and `DATABASE_URL_UNPOOLED`, a direct URL for creating tables.
2. Set `NWC_URI` (and `LSC_URI_PRIMARY`) as above.
3. Send v0 this prompt:

<!-- platform-prompt:begin -->
```text
Add Bitcoin Lightning checkout to this app with OpenReceive. Download the
directions with your terminal and follow them exactly:

curl -fsSL https://openreceive.org/agent-directions/next/full.md

NWC_URI and LSC_URI_PRIMARY are already set as this project's environment
variables, so do not ask me for them. Store payments in the Neon database:
a pg Pool on DATABASE_URL for the app, and DATABASE_URL_UNPOOLED to create
the tables. Use @openreceive packages 0.4.19 or newer.
```
<!-- platform-prompt:end -->

The directions tell v0 how to map the three hooks onto your existing orders
and how to render the checkout. They also tell it to stop and show you the
checkout link when setup is done.

## Check it

In the preview, place an order and open its checkout. You should see the
payment methods and, after you pick Bitcoin, a Lightning invoice in sats. If
no invoice appears, check the preview's logs: usually `NWC_URI` is missing
from the Development environment, or the code is not receive-only.

Pay a small order from your wallet to see it settle: the checkout shows the
payment as received, and `onPaid` marks the order paid.

## How it runs on Vercel

- **No worker or cron job.** Each request to the payment routes also checks
  the wallet for settled invoices, through a lock in your database. A payer
  who closes the tab is settled on the next request. Vercel's once-a-day
  Hobby cron is not needed.
- **Pooled database URL.** Vercel functions reach Neon through its transaction
  pooler. OpenReceive's storage is tested against transaction pooling with
  `pg`, Knex, Prisma (`@prisma/adapter-pg`) and TypeORM.
- **Node runtime.** The payment route runs on Node (`runtime = "nodejs"`),
  never the Edge runtime.
- **Rate limiting.** Keep `rateLimiting: true` with `trustProxyIpHeader: true`.
  Vercel sets `x-forwarded-for`, so the limit applies per payer.
- **Keep order pages reachable.** A payer with a swap in progress comes back
  through `/checkout/<order id>` to claim a refund. See
  [swap refunds](swap-refunds.md).

More detail: [Next.js quickstart](quickstart-next.md),
[Payment storage](storage.md), [Security](security.md).
