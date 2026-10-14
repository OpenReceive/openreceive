# Widget Shop

A small React Router app in framework mode: React Router 8, laid out like its
default template, built with `react-router build` and served by
`react-router-serve`.
Five products, orders and customers in Postgres through `pg`. Pages render on
the server from route loaders; the routes are in `app/routes.ts`. There is no
Vue, Svelte, or Angular app.

`app/shop.server.ts` creates the tables and the catalog, when missing, on the
first request.

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
`react-router-serve` does not load `.env` (`react-router dev` does), so the
server sees only the environment `compose.yml` gives the `web` service.
