# Changelog

## 0.1.1 - Unreleased

OpenReceive is pre-release and has no compatibility or migration commitments.

### Host-owned payment attempts

- The runtime has no persistence configuration. Framework scaffolds use the host
  application's existing database only for `openreceive_payments`.
- Each invoice or swap is an immutable attempt row with a globally unique
  `payment_hash`, a safe checkout snapshot, optional server-only `swap_data`,
  and write-once `paid_at`.
- Attempt creation serializes on the host order row. The host commits the row
  before OpenReceive exposes payer instructions.
- Node adapters use one `OpenReceiveHost` integration for trusted pricing,
  attempt persistence, and replay-safe settlement.

### Settlement

- Payment checks and reconciliation use bounded NIP-47 `list_transactions`
  scans; per-invoice wallet lookup is not required.
- Direct checks require the stored invoice `createdAt`, while reconciliation
  reloads unsettled host attempts and needs no durable cursor.
- Settlement callbacks are at-least-once, record
  every settled attempt, and fulfill only the order's first settlement.
- Notifications and preimages alone are not settlement authority.

### HTTP and security

- Mounted routes implement `spec/openapi/openreceive-http.v1.yaml`.
- The host authorizes each request and resolves prices from host-owned order
  data; payer-supplied amounts are rejected.
- OpenReceive mints no authentication, recovery, or refund tokens.
- Receive-only NWC and swap-provider credentials remain server-only and are
  excluded from public APIs and logs.

### Developer experience

- Node ORM generators scaffold the payment ledger, concurrency transaction,
  settlement transaction, reconciliation query, and host integration.
- The Node quickstart has one service, one host integration, one framework
  adapter, and one reconciliation startup call.
- Removed superseded API aliases, historical response-shape normalization, and
  repository scratch documents.

### Release posture

- Hosted demo deployment templates and public demo deployment docs remain
  outside this public repository.
- The deterministic internal testkit remains private and non-payable.
- Release gates retain package, cross-language, secret, and bundle checks plus
  workflow safety validation.
