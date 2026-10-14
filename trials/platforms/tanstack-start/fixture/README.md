# Widget Shop

A small TanStack Start store, built with Vite and served by Node through
Nitro's `node-server` preset. Five products, and orders and customers in
Postgres through `pg`. Pages render on the server. The shop creates its
tables and its catalog when it first reaches the database.

## Run

```sh
docker compose up --build
```

Compose publishes port 3000 of the `web` service on the host port set in
`compose.yml`. Print that address with:

```sh
docker compose port web 3000
```

The shop listens on that address. `GET /health` answers when it is up.
`npm run dev` (Vite) loads `.env` into `process.env`; the built server that
Compose runs (`node .output/server/index.mjs`) reads only its own environment,
which comes from `compose.yml`.
