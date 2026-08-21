# What is OpenReceive?

OpenReceive connects a host application to a receive-only NWC wallet and optional swap
providers. It creates invoices and verifies settlement.

> **Terminology.** **NWC** (Nostr Wallet Connect, specified by **NIP-47**) is the protocol a
> Lightning wallet exposes so an application can ask it to create invoices and list payments —
> a receive-only NWC connection string is the only wallet credential OpenReceive needs.
> A **BOLT11** invoice is the standard Lightning payment request string payers scan or paste.
> Amounts are counted in **sats** (satoshis, 1/100,000,000 BTC) and **msats** (millisatoshis,
> 1/1000 sat — the unit on the wire). A **rail** is one way to pay a checkout: Lightning
> directly, or a **swap** (the payer sends another asset, e.g. USDT, and a swap provider pays
> the Lightning invoice).

Your application remains the source of truth for orders, users, prices, and fulfillment.
OpenReceive never requires a separate database, Redis, or migration runner — but it may own its
payment-attempt rows (`openreceive_payments`) inside your existing database. You run one
migration and pass a database handle; the library owns the schema, per-order commit locking,
write-once settlement, and the reconciliation state machine. Each row is one invoice/swap
attempt with a row status (`pending | settled | expired | failed | attention`; `attention`
is an operator state that reads as `pending` on the wire) and optional
server-only provider `swap_data`.

Recovery needs no durable cursor: reconciliation reloads `pending` attempts and batch-scans the
wallet's overlapping NIP-47 creation-time range; unresolved swaps are queried with the row's
`swap_data`. Settlement is at-least-once and write-once per attempt; fulfillment runs inside the
settlement transaction, only for the order's first settled attempt. To your application an
order is simply unpaid or paid.
