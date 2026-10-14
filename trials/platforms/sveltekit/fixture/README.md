# Widget Shop

A small SvelteKit store: SvelteKit 3 with `@sveltejs/adapter-node`. Five
products, and orders and customers in Postgres through `pg`. Pages render on
the server. The tables are created, and the catalog added, when the server
starts (`init` in `src/hooks.server.ts`). There is no React, Vue, or Angular app.

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
SvelteKit reads the variables declared in `src/env.ts`: `vite dev` loads them
from `.env`, and the built server (`node build`, which the image runs) only
from its environment, never from `.env`.

The shop runs over plain HTTP with no proxy in front, where adapter-node takes
every request's origin to be `https://<host>`. SvelteKit's Origin check would
then refuse the order form, so `vite.config.ts` turns it off
(`csrf.trustedOrigins: ['*']`).
