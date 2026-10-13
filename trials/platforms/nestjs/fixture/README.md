# Widget Shop

A small NestJS store: Nest 12 on its default Express platform. Five products,
and orders in Postgres through TypeORM. Sessions are express-session, stored in
the same Postgres. Pages are server-rendered Handlebars views in `views/`.
There is no React, Vue, Svelte, or Angular app.

TypeORM runs any pending migration in `src/migrations` when the app starts.

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
