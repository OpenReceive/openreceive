# OpenReceive Next.js + Postgres starter

A one-product shop on Next.js that takes Bitcoin payments over Lightning,
paid straight into your own wallet. Orders and payment attempts live in your
Postgres database. It deploys to Vercel with a Neon database, and it also
runs in v0 and on any Node host. There is no OpenReceive account and no
worker process: payments settle during normal requests.

Optional swaps let customers pay with **USDT, USDC, SOL, and ETH** instead.
A swap provider you configure converts the payment to **BTC over Lightning**,
which settles into the same wallet. Available assets and networks depend on
the provider; swaps are optional.

## Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FOpenReceive%2Fopenreceive%2Ftree%2Fmaster%2Fexamples%2Fnext-postgres-starter&project-name=openreceive-starter&repository-name=openreceive-starter&env=NWC_URI&envDescription=A%20receive-only%20NWC%20code%20from%20your%20Lightning%20wallet&envLink=https%3A%2F%2Fopenreceive.org%2Fget_a_nwc_code_to_receive_payments&stores=%5B%7B%22type%22%3A%22integration%22%2C%22protocol%22%3A%22storage%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%7D%5D)

The button copies this folder into a new GitHub repository, creates a Neon
Postgres database, and asks for `NWC_URI`: a receive-only code from your
Lightning wallet ([get one](https://openreceive.org/get_a_nwc_code_to_receive_payments)).
Every build creates the tables if they are missing, so the first deploy is
ready to take payments.

To accept swaps, add `LSC_URI_PRIMARY` in the project's environment variables
([set up a swap provider](https://openreceive.org/set_up_swap_provider)).

## Run locally

Requires Node 22 or newer and a Postgres database.

```sh
cp env.example .env.local   # then fill in NWC_URI and DATABASE_URL
npm install
npm run dev                 # creates the tables, then starts Next.js
```

## How it fits together

| File | What it does |
| --- | --- |
| `app/actions.ts` | Creates the order before checkout. Its id is the payment reference. |
| `app/openreceive/[...openreceive]/route.ts` | The payment routes: `authorize`, `amountFor` and `onPaid` |
| `app/checkout/[reference]/` | The order's own page, with the drop-in checkout |
| `lib/db.ts` | One `pg` pool on the pooled database URL |
| `scripts/migrate.mjs` | Creates `orders` and OpenReceive's two tables |

The app uses the pooled database URL, Neon's `DATABASE_URL`. It reaches
Postgres through a transaction pooler, which OpenReceive's payment storage is
tested against. Migrations use the direct URL, `DATABASE_URL_UNPOOLED`, when it
is set.

The full walkthrough is the [Next.js quickstart](https://openreceive.org/guides/quickstart-next).
To build on this starter in v0, see [Vercel and v0](https://openreceive.org/guides/vercel).
