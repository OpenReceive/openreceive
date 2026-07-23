# Security

- Keep receive-only NWC and payment-attempt `swap_data` server-side. Scan browser bundles for them.
- Recompute checkout prices from host-owned order/catalog data; reject payer amounts.
- Commit payment hash before exposing the invoice and use a host-row compare-and-set for
  retries/concurrency.
- Accept settlement only from `settled_at` or wallet state `settled`; a preimage is not final
  proof and notifications are only hints.
- Make each attempt's `paid_at` write-once and fulfill only for the order's first settlement
  because `onPaid` is at-least-once.
- Treat `swap_data` as a provider credential: never serialize it into HTTP responses or logs.
  Optional encryption at rest belongs to the host framework/database.
- Provider completion alone does not fulfill an order; wallet settlement does.
