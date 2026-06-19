# Governance

OpenReceive starts with a maintainer-led governance model.

## Maintainer Responsibilities

- Protect the product boundary and security model.
- Keep schemas, vectors, and reference implementations aligned.
- Review changes to v0.1 contract files before parallel implementation work.
- Keep private openreceive.org application details outside the public repo.
- Require tests for behavior that affects invoice creation, settlement,
  idempotency, pricing, provider data, or fulfillment safety.

## Decision Records

Architecture and product decisions that affect public contracts belong in
`docs/adr/`.

## Parallel Work

Parallel implementation starts only after the shared contract for that area is
frozen and has validation. Until then, one lead should own contract files.
