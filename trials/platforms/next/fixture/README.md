# Widget Shop

A small Next.js App Router store. Five products, orders and customers in SQLite, pages are React server components. There is no Vue, Svelte, or Angular app.

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
Next.js loads environment variables from `.env.local`.
