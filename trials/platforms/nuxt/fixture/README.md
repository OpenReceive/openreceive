# Widget Shop

A small Nuxt 4 store. Five products, orders and customers in Postgres through
`pg`. Pages are Vue components in `app/pages/` that render on the server; the
server routes and database code are in `server/`. There is no React, Svelte,
or Angular app.

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
`nuxt dev` loads `.env` into `process.env`, but the built server the image
runs (`node .output/server/index.mjs`) never reads `.env`: it sees only the
environment Compose gives the `web` service.
