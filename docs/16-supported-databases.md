# Supported Databases

OpenReceive provides its own invoice persistence for invoice lifecycle,
idempotency, polling recovery, and settlement-action state. Use the package
migration/setup path for your database, then keep your app's orders, carts,
users, products, and fulfillment state in your existing tables.

A database is supported only when OpenReceive ships all three pieces:

- a package-owned store adapter
- a package-owned migration or framework setup path
- conformance coverage for idempotency, recovery, and settlement transitions

## Matrix

| Runtime | Database | Status | Setup Path | Intended Use |
| --- | --- | --- | --- | --- |
| Node | Postgres | Supported | `openreceive migrate --postgres "$DATABASE_URL"` and `createOpenReceivePostgresInvoiceStoreFromPool()` | Production/reference deployments |
| Node | SQLite | Supported | `openreceive migrate --sqlite ./storage/openreceive.sqlite3` and `createOpenReceiveSqliteInvoiceStore()` | Local development, demos, small apps |
| Rails | ActiveRecord SQLite | Initial adapter path | Rails migration/model template and `bin/rails db:prepare` | Rails demo and early Rails apps |

`InMemoryInvoiceStore` is for tests and throwaway demos only. Node/Express
refuses to mount routes or start poll/listen runners with in-memory invoice
storage when `OPENRECEIVE_MODE=production` or `NODE_ENV=production`.

MongoDB, MySQL, Prisma-native models, Drizzle-native models, and custom
invoice tables are future adapter work. Prisma and Drizzle recipes should wrap
the package-owned SQL schema once those recipes exist.

Keep app-owned references such as user ids, order ids, cart ids, product ids,
and tenant-specific fields in OpenReceive metadata or in your own app tables.
That keeps package migrations simple while still letting your app connect
settled invoices to the right business records.
