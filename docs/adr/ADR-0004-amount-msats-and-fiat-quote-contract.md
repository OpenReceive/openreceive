# ADR-0004: amount_msats And Fiat Quote Contract

## Status

Accepted for v0.1.

## Context

NIP-47 uses `amount` to mean millisatoshis. Merchant APIs often use `amount` to
mean fiat, sats, or display money, which is unsafe.

## Decision

OpenReceive public HTTP and SDK payloads use `amount_msats` for millisatoshis
and `amount_sats` for satoshis. Raw NIP-47 adapters map `amount_msats` to and
from NIP-47 `amount` at the boundary.

Fiat values use string decimals. BTC fiat prices use string decimals. Fiat to
msat conversion uses decimal/integer math, rounds up to whole sats for v0.1,
and enforces:

- `amount_msats` minimum: `1000`
- `amount_msats` maximum: `9007199254740991`
- `amount_sats` minimum: `1`
- `amount_sats` maximum: `9007199254740`

## Consequences

- Do not use binary floating point for fiat math.
- Create invoice requests contain exactly one amount source: `amount_msats` or
  `fiat`.
- A fiat quote is locked at invoice creation and stored with the invoice.
