# Widget Shop

A small Next.js App Router store, deployed on Vercel. Five products, users and
orders live in a Neon Postgres database, reached with the `pg` driver. Pages are
React server components. There is no Vue, Svelte, or Angular app.

## Environment

Vercel supplies the environment variables. They are project settings, not files
in this repository:

- `DATABASE_URL`: Neon's pooled connection (transaction pooling)
- `DATABASE_URL_UNPOOLED`: Neon's direct connection, for creating tables

`npm run build` creates the tables and the products before `next build`, so
every Vercel deploy is ready to serve.

## Run locally

```sh
docker compose up --build
```

Compose runs Postgres behind PgBouncer in transaction mode, the way Neon's
pooler works, and gives the `web` service the project's environment variables,
the way Vercel does. Print the shop's address with:

```sh
docker compose port web 3000
```

`GET /health` answers when it is up.
