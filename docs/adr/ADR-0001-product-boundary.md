# ADR-0001: Product Boundary

## Status

Accepted for v0.1.

## Context

OpenReceive needs clear wording and conservative behavior. It adds
uncensorable, global, permissionless inbound payments to merchant apps by
creating receive-side Lightning invoices and showing friendly payer-side route
guidance. It must not look or behave like a processor, exchange, wallet,
custodian, broker, or bank.

## Decision

OpenReceive creates one BOLT11 invoice through a merchant-controlled backend
and verifies settlement before a merchant-owned settlement action. It may
display route guidance for third-party services that may help purchasers start
from a credit card, bank account, Bitcoin wallet, stablecoin balance, exchange,
onramp, or swap service and reach that invoice.

OpenReceive does not custody funds, exchange assets, operate accounts, transmit
money, or guarantee provider route availability.

## Consequences

- Docs and UI may say purchasers can start from cards, bank accounts, Bitcoin,
  stablecoins, exchanges, onramps, or swaps, but must not say OpenReceive
  itself processes those payments.
- Provider registry claims need conservative wording and evidence.
- The backend owns settlement verification and merchant settlement actions.
