# Security Policy

OpenReceive handles receive-only payment infrastructure. Treat every NWC string
as a secret even when it cannot spend funds.

## Reporting

Until a public security inbox is published, open a private security advisory on
GitHub or contact the maintainers through the repository owner.

## Required Controls

- NWC secrets never enter browser or mobile bundles.
- Real env files stay ignored. Commit `.env.example` only.
- Logs, errors, screenshots, telemetry, and tests must redact NWC secrets.
- Frontends never fulfill products by themselves.
- Settlement is verified by backend `lookup_invoice`.
- Fulfillment transitions must be idempotent.
- Invoice creation must use idempotency keys.
- Public demos must use low amounts, rate limits, and separate receive-only
  wallet credentials.

## Secret Scanning

Run:

```sh
npm run scan:secrets
```

The scanner is intentionally conservative and local. Hosted CI should add a
dedicated secret-scanning service before public contribution volume grows.
