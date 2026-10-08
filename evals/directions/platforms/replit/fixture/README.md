# Widget Shop

A small Express store, built and hosted on Replit. Five products, users and
orders live in Replit's Postgres database, reached with the `pg` driver. Pages
are server-rendered HTML. There is no React, Vue, Svelte, or Angular app.

## Environment

Replit supplies the environment. These are app settings, not files in this
repository:

- `DATABASE_URL`: Replit's Postgres 16, a direct connection with no pooler
- Secrets from the Replit Secrets tool, as environment variables

The server creates its tables and products at every start.

## Run

```sh
docker compose up --build
```

Compose runs the same Postgres version Replit does and gives the `web`
service the app's environment, the way Replit does. Print the shop's address
with:

```sh
docker compose port web 5000
```

`GET /health` answers when it is up.
