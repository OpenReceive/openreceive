# Storage

OpenReceive owns its invoice storage. Your app keeps orders, carts, users,
products, fulfillment state, and tenant-specific columns in your own tables.
Link app records to OpenReceive invoices through your app records or invoice
`orderId`.

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

Use this store only for OpenReceive invoice state. App migrations should stay
focused on your own app tables.

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

Use one shared durable OpenReceive store before adding more than one web
process, serverless instance, worker, scheduler, or any deployment with an
ephemeral filesystem. In v0.1 Node, that shared store is Postgres:

```sh
OPENRECEIVE_STORE=postgres://openreceive:password@db.example.com:5432/openreceive
OPENRECEIVE_NAMESPACE=prod
```

`local-sqlite` is acceptable for single-machine self-hosting when the SQLite
file is on durable disk. Do not use a per-instance SQLite file when multiple
servers run the same checkout code.

Do not point OpenReceive at arbitrary app tables, ORM models, object storage,
browser-accessible storage, MySQL, remote SQLite, or platform KV such as
Cloudflare Workers KV unless this package explicitly ships an OpenReceive store
adapter for that backend. The store contains wallet-derived payment state and
must stay server-side.
