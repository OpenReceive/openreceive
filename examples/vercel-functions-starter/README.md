# OpenReceive Vercel Functions starter

A one-product shop on Vercel with no framework: a static page, and plain
JavaScript functions in `api/`. It takes Bitcoin payments over Lightning,
paid straight into your own wallet. Orders and payment attempts live in your
Postgres database. There is no OpenReceive account and no worker process:
payments settle during normal requests.

Optional swaps let customers pay with **USDT, USDC, SOL, and ETH** instead.
A swap provider you configure converts the payment to **BTC over Lightning**,
which settles into the same wallet. Available assets and networks depend on
the provider; swaps are optional.

## Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FOpenReceive%2Fopenreceive%2Ftree%2Fmaster%2Fexamples%2Fvercel-functions-starter&project-name=openreceive-functions-starter&repository-name=openreceive-functions-starter&env=NWC_URI&envDescription=A%20receive-only%20NWC%20code%20from%20your%20Lightning%20wallet&envLink=https%3A%2F%2Fopenreceive.org%2Fget_a_nwc_code_to_receive_payments&stores=%5B%7B%22type%22%3A%22integration%22%2C%22protocol%22%3A%22storage%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%7D%5D)

The button copies this folder into a new GitHub repository, creates a Neon
Postgres database, and asks for `NWC_URI`: a receive-only code from your
Lightning wallet ([get one](https://openreceive.org/get_a_nwc_code_to_receive_payments)).
Every build creates the tables if they are missing, so the first deploy is
ready to take payments.

To accept swaps, add `LSC_URI_PRIMARY` in the project's environment variables
([set up a swap provider](https://openreceive.org/set_up_swap_provider)), then
redeploy.

## How it fits together

| File | What it does |
| --- | --- |
| `public/index.html` | The product and its Buy button |
| `api/orders.js` | Creates the order before checkout. Its id is the payment reference. |
| `api/checkout.js` | The order's own page, `/checkout/<id>`, with the checkout element |
| `api/order-swap.js` | Keeps a swap's payment hash on the order, so a payer back for a refund gets that swap |
| `api/openreceive.js` | The payment routes: `authorize`, `amountFor` and `onPaid` |
| `lib/db.js` | One `pg` pool on Neon's pooled `DATABASE_URL` |
| `lib/orders.js` | The orders table, and the buyer's cookie |
| `scripts/build.mjs` | Creates the tables and copies the checkout element's two files into `public/` |
| `vercel.json` | The rewrite that sends `/openreceive/*` to one function |

The buyer's cookie is a random id kept on the order row, so it needs no
signing secret. The payment routes run on Node, and the OpenReceive stack is
built on the first request: Vercel can load a function before a request
arrives, and a stack built then can refuse the first payer.

The full walkthrough is the
[Vercel Functions recipe](https://openreceive.org/guides/vercel-functions-recipe),
and the guide is
[Bitcoin checkout on Vercel Functions](https://openreceive.org/guides/vercel-functions).
