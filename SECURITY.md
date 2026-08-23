# Security Policy

OpenReceive handles receive-only NWC payment infrastructure. Treat every NWC code
as private even when it cannot spend funds.

## Reporting

Report vulnerabilities privately to info@openreceive.org, or open a private
security advisory on GitHub. Please do not open a public issue for a suspected
vulnerability.

## Required Controls

- Receive-only NWC codes never enter browser or mobile bundles.
- Real env files stay ignored. Commit `.env.example` only.
- Logs, errors, screenshots, telemetry, and tests must redact receive-only NWC
  codes.
- Frontends never run merchant settlement actions by themselves.
- Settlement is verified by backend status refresh using NWC `list_transactions`.
- Each checkout is persisted as one library-owned `openreceive_payments` row
  (in the host's database — the host owns orders; ownership rule:
  [Payment storage](docs/guides/storage.md)) before payer instructions are
  exposed. A row represents one direct payment attempt or one provider swap
  attempt, never several provider orders.
- Checkout creation serializes per `order_id` on OpenReceive-owned rows,
  reuses the order's one live attempt, and rejects creation after any sibling
  attempt has settled. The host's order table is never read, written, locked,
  or joined.
- Payment, swap-status, and refund requests include the displayed
  `payment_hash`; the host verifies that the selected attempt belongs to the
  authorized order.
- Each attempt's `paid_at` transition is write-once. The host fulfills the
  order only for its first settled attempt, so replay and late settlement are
  harmless.
- `swap_data` remains server-only and is excluded from serialization, logs,
  errors, and browser responses.
- Public product demos (on openreceive.org) must use low amounts, rate limits,
  and separate receive-only NWC codes.

## Secret Scanning

Run:

```sh
npm run scan:secrets
```

The scanner is intentionally conservative and local. Hosted CI should add a
dedicated secret-scanning service before public contribution volume grows.
