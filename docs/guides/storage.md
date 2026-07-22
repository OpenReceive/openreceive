# Storage

OpenReceive owns its invoice storage. Your app keeps orders, carts, users,
products, fulfillment state, and tenant-specific columns in your own tables.
Link app records to OpenReceive invoices through your app records or invoice
`orderId`.

## Store URI

Store selection when `store` is omitted:

1. `DATABASE_PRIVATE_URL` if it is a `postgres://` / `postgresql://` URI
2. else `DATABASE_URL` if it is a Postgres URI
3. else `local-sqlite` (only where the platform allows durable local files)

Explicit `store` always wins. Non-Postgres `DATABASE_URL` values
(mysql, redis, sqlite, …) are ignored so OpenReceive does not mis-adopt them.

Override in `openreceive.yml` only when you need to:

```yaml
store: local-sqlite
namespace: default
```

Supported v0.1 store values:

| Value | Status | Use |
| --- | --- | --- |
| `local-sqlite` | Supported for Node | Creates `./.openreceive/<namespace>.sqlite3`; with the default namespace this is `./.openreceive/default.sqlite3`. Use for local development and raw single-machine self-hosting. |
| `sqlite:/absolute/path/to/openreceive.sqlite3` | Supported for Node | Uses an explicit SQLite file on one durable machine or one PaaS instance with a real mounted volume. |
| `postgres://...` | Supported for Node | Recommended for production, serverless, managed platforms, and multi-instance deployments. Also adopted automatically from `DATABASE_URL` / `DATABASE_PRIVATE_URL`. |

OpenReceive uses its own namespaced tables inside the chosen database. App
migrations should stay focused on your own app tables.

## Schema setup

For local development, `local-sqlite` creates its database and OpenReceive
tables automatically.

For Postgres, run the migration step before booting the app. When
`store` is omitted, `openreceive migrate` uses the same
`DATABASE_PRIVATE_URL` / `DATABASE_URL` precedence as runtime:

```sh
openreceive migrate --namespace prod
# or explicitly, using the same store URI as `store` in openreceive.yml:
openreceive migrate --store "postgres://USER:PASS@HOST:5432/DB" --namespace prod
```

To inspect the SQL first:

```sh
openreceive migrate --print
```

At runtime, Postgres startup checks that OpenReceive tables and metadata already
exist. If migrations have not been run, OpenReceive refuses to boot with a
`STORE_MIGRATIONS_REQUIRED` error and the command to run. It does **not**
auto-migrate into a host Postgres database.

## Production

Postgres works anywhere and is the recommended default. On Heroku, Railway,
Render, and similar hosts, a Postgres `DATABASE_URL` is enough — omit
`store`. To set the store explicitly:

```yaml
store: postgres://USER:PASS@HOST:5432/DB
```

SQLite is only for one durable machine, or one PaaS instance with a real mounted
volume — never on ephemeral serverless filesystems:

```yaml
store: sqlite:/absolute/mounted/volume/openreceive.sqlite3
```

Platform matrix and multi-instance rules:
[Deployment Storage](../internal/deployment-storage.md).

Do not point OpenReceive at arbitrary app tables, MySQL, remote SQLite, or
platform KV such as Cloudflare Workers KV unless this package ships an adapter
for that backend. The store contains wallet-derived payment state and must stay
server-side.

## Namespaces

`namespace` separates independent OpenReceive installations that
share the same physical store. Use a short, lowercase value such as `default`,
`prod`, or `acme_shop`. Changing the namespace points OpenReceive at a different
logical store inside the same backend.

OpenReceive uses the namespace as part of the idempotency scope for checkout
invoice rows. Use separate namespaces or separate OpenReceive instances when
two apps should not share replay keys.
