# Widget Shop

A small Astro 7 site on the Node adapter (`@astrojs/node`, standalone). Five
products, and orders and customers in Postgres through `pg`. The shop's pages
and endpoints render on demand (`export const prerender = false`); the About
page is static. There is no React, Vue, Svelte, or Angular app.

`src/lib/db.ts` creates the tables and seeds the catalog on first use. Its
`DATABASE_URL` is declared in `astro.config.mjs` under `env.schema`.

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
`astro dev` reads `.env` into `import.meta.env` and `astro:env` but not into
`process.env`; the built server reads `astro:env` secrets and `process.env`
from the container's environment when it runs, and `import.meta.env` keeps only
what `astro build` saw.
