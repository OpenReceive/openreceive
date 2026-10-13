# OpenReceive NestJS starter

A one-product shop on NestJS that takes Bitcoin payments over Lightning, paid
straight into your own wallet. Orders, sessions and payment attempts live in
your Postgres database, through TypeORM. There is no OpenReceive account and
no worker process: payments settle during normal requests.

Optional swaps let customers pay with **USDT, USDC, SOL, and ETH** instead.
A swap provider you configure converts the payment to **BTC over Lightning**,
which settles into the same wallet. Available assets and networks depend on
the provider; swaps are optional.

## Run it

Requires Docker, or Node 22 or newer and a Postgres database.

```sh
npx degit OpenReceive/openreceive/examples/nestjs-starter my-shop
cd my-shop
cp env.example .env   # then fill in NWC_URI and SESSION_SECRET
docker compose up --build
```

`NWC_URI` is a receive-only code from your Lightning wallet
([get one](https://openreceive.org/get_a_nwc_code_to_receive_payments)). To
accept swaps, also set `LSC_URI_PRIMARY`
([set up a swap provider](https://openreceive.org/set_up_swap_provider)).

Open http://localhost:3000 and buy the sticker to see a Lightning invoice.
TypeORM runs the migrations in `src/migrations` when the app starts.

Without Docker, set `DATABASE_URL` in `.env` as well, then:

```sh
npm install
npm run build
node --env-file=.env dist/main.js
```

## How it fits together

| File | What it does |
| --- | --- |
| `src/main.ts` | Sessions, then the payment routes: `authorize`, `amountFor` and `onPaid` |
| `src/orders/` | The order entity, service and pages. The order's id is the payment reference. |
| `src/migrations/` | The orders table, and OpenReceive's two tables from `npx openreceive scaffold payments --orm typeorm` |
| `views/` | The Handlebars pages. The order page holds the checkout. |

OpenReceive is Express middleware, mounted with `app.use()` in `main.ts`, so
Nest's guards do not run for it. `authorize` makes the order page's own check
instead: the session that placed the order is the one that may pay for it.
Nest adds its JSON body parser only when the app starts listening, so
`main.ts` adds it before the mount with `app.useBodyParser("json")`.

The checkout is the `<openreceive-checkout>` element. The server sends its
script and stylesheet straight from `@openreceive/elements`, so there is
nothing to build on the frontend.

The full walkthrough is the [NestJS quickstart](https://openreceive.org/guides/quickstart-nestjs).
