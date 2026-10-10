# Widget Shop

A small store built with Lovable: a TanStack Start app on Lovable Cloud.
Five products and the orders live in the project's Supabase database. Server
code reads and writes them with `supabaseAdmin`
(`src/integrations/supabase/client.server.ts`), over Supabase's HTTPS API.

- `/`: the catalog. Each product's Buy form posts to `/orders`.
- `POST /orders`: creates the order on the server, its price copied from the
  product, and redirects to `/orders/<id>`.
- `/orders/<id>`: the order and its status, `awaiting_payment` until paid.

## Environment

Lovable supplies the environment. Nothing here is a file in this repository:

- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, for server code
- the project's secrets, managed in Lovable under Cloud → Secrets

## Database changes

Database changes are Supabase migrations in `supabase/migrations/`. Lovable
applies a new migration when the project's owner approves it.

## Run locally

```sh
docker compose up --build
```

Compose runs Supabase's own Postgres image, its PostgREST API and a stand-in
for its API gateway, and gives the `web` service the environment Lovable
gives the app. To apply new migrations the way Lovable does after approval:

```sh
docker compose run --rm migrate
```

Print the shop's address with `docker compose port web 3000`. `GET /health`
answers when it is up.
