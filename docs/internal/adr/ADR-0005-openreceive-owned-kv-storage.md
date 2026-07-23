# ADR-0005: No OpenReceive-owned storage

Status: Superseded

The former KV/SQLite/Postgres design is retired. OpenReceive accepts no database connection,
ships no migration, and persists no invoice, meta, cursor, token-hash, or workflow row.

Wallet facts are recoverable from NWC by payment hash/range scan. Swap provider workflow facts
are recoverable with a host-carried authenticated encrypted recovery token. Host order and
fulfillment state stay in the host database.
