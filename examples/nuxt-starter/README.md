# OpenReceive Nuxt starter

A one-product shop on Nuxt 4 that takes Bitcoin payments over Lightning,
paid straight into your own wallet, with the
[`@openreceive/nuxt`](https://openreceive.org/integrations/nuxt) module.
Orders and payment attempts live in your Postgres database. There is no
OpenReceive account and no worker process: payments settle during normal
requests.

Optional swaps let customers pay with **USDT, USDC, SOL, and ETH** instead.
A swap provider you configure converts the payment to **BTC over Lightning**,
which settles into the same wallet. Available assets and networks depend on
the provider; swaps are optional.

## Run it

Requires Node 22 or newer and a Postgres database.

```sh
npx degit OpenReceive/openreceive/examples/nuxt-starter my-shop
cd my-shop
cp env.example .env   # then fill in NWC_URI and DATABASE_URL
npm install
npm run dev           # nuxt dev loads .env and serves on port 3000
```

`NWC_URI` is a receive-only code from your Lightning wallet
([get one](https://openreceive.org/get_a_nwc_code_to_receive_payments)). To
accept swaps, also set `LSC_URI_PRIMARY`
([set up a swap provider](https://openreceive.org/set_up_swap_provider)).
The server creates its tables when it starts. Buy the sticker to see a
Lightning invoice.

In production, build with `npm run build` and start with
`node --env-file=.env .output/server/index.mjs`, or set the variables in the
server's environment: the built server does not read `.env`.

`package.json` holds `vue-router` at 5.4.0. With 5.5.2, a Nuxt 4.7.0 build
answers every page with a 500 (`__VUE_OPTIONS_API__ is not defined`), with or
without OpenReceive.

## How it fits together

| File | What it does |
| --- | --- |
| `nuxt.config.ts` | Adds `@openreceive/nuxt`: the payment routes at `/openreceive/**` and `<OpenReceiveCheckout>` |
| `server/openreceive.ts` | The three hooks: `authorize`, `amountFor` and `onPaid` |
| `server/utils/orders.ts` | Creates the order before checkout. Its id is the payment reference. |
| `server/plugins/schema.ts` | Creates `orders` and OpenReceive's two tables at every start |
| `server/routes/orders.post.ts` | Buy: places the order and opens its page |
| `app/pages/orders/[id].vue` | The order's own page, with the checkout until it is paid |

The full walkthrough is the [Nuxt quickstart](https://openreceive.org/guides/quickstart-nuxt).
