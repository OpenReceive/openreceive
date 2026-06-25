# Storage

OpenReceive owns its invoice storage. Your app keeps orders, carts, users,
products, fulfillment state, and tenant-specific columns in your own tables.
Link app records to OpenReceive invoices through your app records or invoice
`orderUuid`.

## Store URI

Set `OPENRECEIVE_STORE` on the server:

```sh
OPENRECEIVE_STORE=local-sqlite
OPENRECEIVE_NAMESPACE=default
```

Supported v0.1 store values:

| Value | Status | Use |
| --- | --- | --- |
| `local-sqlite` | Supported for Node | Creates `./.openreceive/<namespace>.sqlite3`; use for local development, demos, and single-machine self-hosting. |
| `sqlite:/path/to/openreceive.sqlite3` | Supported for Node | Uses an explicit SQLite file on one machine. |
| `postgres://...` | Supported for Node | Use for production, serverless, and multi-instance deployments. |
| `memory:` | Tests only | Use only in unit tests and throwaway local experiments. |

OpenReceive initializes and owns its package schema. App migrations should not
create or alter OpenReceive invoice tables.

## Namespaces

`OPENRECEIVE_NAMESPACE` separates independent OpenReceive installations that
share the same physical store. Use a short, lowercase value such as `default`,
`prod`, or `acme_shop`.

Changing the namespace points OpenReceive at a different logical store inside
the same backend.

OpenReceive uses the namespace as the idempotency scope for `order_uuid`
replays. Use separate namespaces or separate OpenReceive instances when two
apps should not share invoice replay keys.

## Production Choices

Use Postgres before adding more than one web process or deploying to an
ephemeral filesystem:

```sh
OPENRECEIVE_STORE=postgres://openreceive:password@db.example.com:5432/openreceive
OPENRECEIVE_NAMESPACE=prod
```

`local-sqlite` is acceptable for single-machine self-hosting when the SQLite
file is on durable disk. Do not share one SQLite file across multiple hosts.

Do not point OpenReceive at arbitrary app tables, ORM models, object storage,
browser-accessible storage, or Cloudflare Workers KV. The store contains
wallet-derived payment state and must stay server-side.

## Runtime Tuning

Keep the defaults unless your deployment has measured pressure:

| Variable | Purpose |
| --- | --- |
| `OPENRECEIVE_LOOKUP_BURST` | Maximum immediate backend wallet lookups per namespace. |
| `OPENRECEIVE_LOOKUP_RATE_PER_SEC` | Steady refill rate for lookup gates. |
| `OPENRECEIVE_ACTION_LEASE_TTL_SEC` | Settlement-action lease duration before another process may retry. |
| `OPENRECEIVE_SWEEP_INTERVAL_SEC` | Minimum interval between route-triggered recovery sweeps. |
| `OPENRECEIVE_SWEEP_BATCH` | Maximum invoices examined by one recovery sweep. |
