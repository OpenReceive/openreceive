# Widget Shop

A small Express store. Five products, users and orders live in a Supabase
project's Postgres database, reached with the `pg` driver through Supabase's
transaction pooler. Pages are server-rendered HTML. There is no React, Vue,
Svelte, or Angular app.

## Environment

The host sets these in the server's environment. They are not in a file in
this repository:

- `DATABASE_URL`: Supabase's transaction pooler, port 6543
- `SUPABASE_CA_CERT`: the text of Supabase's `prod-ca-2021.crt`, which
  `lib/db.js` trusts for the pooler's certificate

The server creates its tables and products at every start.

## Run

```sh
docker compose up --build
```

Print the shop's address with:

```sh
docker compose port web 3000
```

`GET /health` answers when it is up.
