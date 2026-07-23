# ADR-0003: Host-row invoice idempotency

Status: Accepted (supersedes the former OpenReceive idempotency-store design)

OpenReceive owns no idempotency table. The host's existing order row is the guard. A create
attempt stores exactly one live `payment_hash` before returning payer instructions. Concurrent
losers abandon and withhold their invoices. Retried requests reuse the host's committed attempt
or mint only after the host decides the previous attempt is no longer live.

This places the price, order identity, and concurrency decision in the system that owns them.
