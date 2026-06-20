# ADR-0001: Product Boundary

## Status

Accepted for v0.1.

## Context

OpenReceive needs conservative wording and behavior. It creates receive-side
Lightning invoices for merchant apps and may show payer-side route suggestions.
It must not look or behave like a processor, exchange, wallet, custodian,
broker, or bank.

## Decision

OpenReceive creates one BOLT11 invoice through a merchant-controlled backend
and verifies settlement before a merchant-owned settlement action. It may
display route suggestions for third-party services that may be able to pay that
invoice.

OpenReceive does not custody funds, exchange assets, operate accounts, transmit
money, or guarantee provider route availability.

## Consequences

- Docs and UI must say "route suggestions", not "pay with fiat" or "pay with
  crypto".
- Provider registry claims need conservative wording and evidence.
- The backend owns settlement verification and merchant settlement actions.
