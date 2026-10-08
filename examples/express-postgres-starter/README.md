# OpenReceive Express + Postgres starter

A one-product shop on Express that takes Bitcoin payments over Lightning,
paid straight into your own wallet. Orders and payment attempts live in your
Postgres database. It is set up for Replit, and it runs on any Node host.
There is no OpenReceive account, no build step and no worker process:
payments settle during normal requests.

Optional swaps let customers pay with **USDT, USDC, SOL, and ETH** instead.
A swap provider you configure converts the payment to **BTC over Lightning**,
which settles into the same wallet. Available assets and networks depend on
the provider; swaps are optional.

## Run it on Replit

Replit imports a whole GitHub repository, so first copy this folder into a
repository of your own:

```sh
npx degit OpenReceive/openreceive/examples/express-postgres-starter my-shop
```

Push `my-shop` to GitHub, then import it at
[replit.com/import](https://replit.com/import) → **GitHub**.

1. In the **Secrets** tool, add `NWC_URI`: a receive-only code from your
   Lightning wallet ([get one](https://openreceive.org/get_a_nwc_code_to_receive_payments)).
   To accept swaps, also add `LSC_URI_PRIMARY`
   ([set up a swap provider](https://openreceive.org/set_up_swap_provider)).
   Without `NWC_URI` the server stops at start and says where to get one.
2. Select **Run**. Replit's database is already in `DATABASE_URL`, and the
   server creates its tables at start. Buy the sticker in Preview to see a
   Lightning invoice.
3. Select **Publish** and keep **Autoscale**. Under **Advanced settings**,
   **Deployment secrets** should list `NWC_URI` (and `LSC_URI_PRIMARY`):
   Replit links your Secrets to the published app.

The published app gets its own production database. The server creates its
tables there on first start.

`replit.md` tells Replit Agent how the payment code fits together, so you can
ask Agent for products, pages and design and keep checkout working.

## Run locally

Requires Node 22 or newer and a Postgres database.

```sh
cp env.example .env   # then fill in NWC_URI and DATABASE_URL
npm install
npm run dev           # loads .env, creates the tables, serves on port 5000
```

## How it fits together

| File | What it does |
| --- | --- |
| `server.js` | The pages, order creation, and the payment routes: `authorize`, `amountFor` and `onPaid` |
| `lib/orders.js` | Creates the order before checkout. Its id is the payment reference. |
| `lib/schema.js` | Creates `orders` and OpenReceive's two tables at every start |
| `lib/db.js` | One `pg` pool on `DATABASE_URL` |

The checkout is the `<openreceive-checkout>` element. The server sends its
script and stylesheet straight from `@openreceive/elements`, so there is
nothing to build.

The full walkthrough is the [Express quickstart](https://openreceive.org/guides/quickstart-node).
To add checkout to an app Replit Agent built, see [Replit](https://openreceive.org/guides/replit).
