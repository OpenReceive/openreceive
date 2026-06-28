# OpenReceive Ruby

This is the first Ruby core package slice for OpenReceive. It intentionally
contains only shared-contract helpers that can run without a receive-only NWC code:

- exact decimal fiat-to-sats/msats quoting
- settlement detection where `settled_at`, `state == "settled"`, or
  `transaction_state == "settled"` is authoritative
- NWC URI parse/redaction helpers backed by the shared `nwc-uri-parse` vectors
- receive-only NIP-47 make-invoice and list-transactions request/response mapping backed
  by the shared `nwc-request-response` vectors
- transaction scan pagination and idempotency replay/conflict helpers backed by
  shared vectors
- an in-memory invoice store for local tests
- a receive-only wrapper for `nwc-ruby` clients that maps documented
  `make_invoice(amount:, ...)` and `list_transactions(...)` calls
  without exposing spend methods

It does not include a Rails engine, standalone Nostr protocol implementation,
or browser/mobile code.
The in-memory store is not a production database adapter.
Rails work builds on this package plus `nwc-ruby` inside your server app. The
Rails adapter refreshes status only inside request-driven controller actions,
keeps receive-only NWC codes out of frontend runtimes, and is still being
aligned with the OpenReceive-owned KV storage contract.
