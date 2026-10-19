# Widget Shop

A Vendure 3 shop in two projects, run with Docker Compose:

- `server/`: the Vendure server, laid out as `@vendure/create` makes a new
  project. `src/vendure-config.ts` is its configuration; `src/index.ts` runs
  the migrations in `src/migrations` and starts the server, and the `worker`
  service runs `src/index-worker.ts` for the job queue and scheduled tasks.
  The database is PostgreSQL.
- `storefront/`: Vendure's official Next.js starter. Its checkout is in
  `src/features/checkout`.

Five products, a guest checkout, free shipping and Vendure's "Standard
Payment" test method.

## Run

```sh
docker compose up -d --build
```

Compose publishes port 3000 of the `storefront` service on the host port set
in `compose.yml`. Print that address with:

```sh
docker compose port storefront 3000
```

The storefront builds when it starts, so it answers a minute or two after the
server. The Vendure server is reachable from the other services at
`http://server:3000` (the Shop API is `/shop-api`).
