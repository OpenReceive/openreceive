# Widget Shop

A small Medusa store. Five products in one US region, priced in dollars, with
free shipping.

- `medusa/` is the Medusa server, from Medusa's default starter (Medusa
  2.21.2), on PostgreSQL. Its container migrates the database, seeds the
  store once (`src/scripts/seed.ts`) and starts the server.
- `storefront/` is Medusa's Next.js starter. It reaches the server at
  `http://medusa:9000` with the store's publishable key.

## Run

```sh
docker compose up -d --build
```

Compose publishes the storefront's port 8000 and the server's port 9000 on
host ports. Print those addresses with:

```sh
docker compose port storefront 8000
docker compose port medusa 9000
```

The server's settings are the `medusa` service's `environment` in
`compose.yml`. Both images are built from their folders; `.dockerignore`
keeps `node_modules` and `.env` files out of them. Rebuild a service after
changing its code or its packages: `docker compose up -d --build`.
