# ADR-0007: Settlement Action Delivery

## Status

Accepted for v0.1-v2.

## Context

OpenReceive cannot atomically commit both its invoice state and arbitrary app
fulfillment state. A process can crash after the app hook succeeds and before
OpenReceive records completion.

## Decision

Settlement actions are delivered at least once. OpenReceive records a
store-backed claim on the invoice before running the app hook so two processes
do not run the same hook at the same time, and so crashed claims can be retried.
Host apps must make settlement hooks idempotent, usually by deduplicating on
`payment_hash` or by using a conditional app-store update.

## Consequences

- Hooks may replay after lease expiry.
- Hooks should not rely on frontend state.
- Documentation and tests must describe duplicate/replay-safe settlement
  behavior.
