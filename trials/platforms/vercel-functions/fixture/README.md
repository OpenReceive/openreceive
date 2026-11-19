# Widget Shop

A small shop on Vercel with no framework: static pages in `public/`, and Node
functions in `api/` that use Vercel's `(req, res)` helpers. Five products and
the orders live in a Neon Postgres database, reached with the `pg` driver.
Buyers are guests: each one gets a cookie signed with `SESSION_SECRET`.

| Path | What serves it |
| --- | --- |
| `/` | `public/index.html`, the products and their Buy buttons |
| `POST /orders` | `api/orders.js`, through the rewrite in `vercel.json` |
| `/orders/:id` | `api/order.js`, the guest's order page |
| `/health` | `api/health.js` |

## Environment

Vercel supplies the environment variables. They are project settings, not files
in this repository:

- `DATABASE_URL`: Neon's pooled connection (transaction pooling)
- `DATABASE_URL_UNPOOLED`: Neon's direct connection, for creating tables
- `SESSION_SECRET`: signs the guest cookie

`npm run build` creates the tables and the products, so every Vercel deploy is
ready to serve.

## Run locally

```sh
docker compose up --build
```

Compose runs Postgres behind PgBouncer in transaction mode, the way Neon's
pooler works, and gives the `web` service the project's environment variables,
the way Vercel does. `infra/vercel-local.mjs` serves the site the way a Vercel
deployment does: `public/`, the functions in `api/`, and the rewrites in
`vercel.json`. It runs `npm run build` first, as every deploy does. Print the
shop's address with:

```sh
docker compose port web 3000
```

`GET /health` answers when it is up.
