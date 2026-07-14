# Security Policy

OpenReceive handles receive-only NWC payment infrastructure. Treat every NWC code
as private even when it cannot spend funds.

## Reporting

Until a public security inbox is published, open a private security advisory on
GitHub or contact the maintainers through the repository owner.

## Required Controls

- Receive-only NWC codes never enter browser or mobile bundles.
- Real env files stay ignored. Commit `.env.example` only.
- Logs, errors, screenshots, telemetry, and tests must redact receive-only NWC
  codes.
- Frontends never run merchant settlement actions by themselves.
- Settlement is verified by backend status refresh using NWC `list_transactions`.
- Settlement action transitions must be idempotent.
- Invoice creation must use idempotency keys.
- Public product demos (on openreceive.org) must use low amounts, rate limits,
  and separate receive-only NWC codes.

## Secret Scanning

Run:

```sh
npm run scan:secrets
```

The scanner is intentionally conservative and local. Hosted CI should add a
dedicated secret-scanning service before public contribution volume grows.
