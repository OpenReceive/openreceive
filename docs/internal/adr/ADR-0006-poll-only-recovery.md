# ADR-0006: Poll-Only Recovery

## Status

Accepted for v0.1-v2.

## Context

Long-running notification listeners and in-memory event buses do not fit the
default deployment shape for serverless platforms, multi-process servers, or
horizontally scaled apps. Notifications are hints, while settlement authority is
backend wallet lookup.

## Decision

OpenReceive discovers settlement only with receive-side `lookup_invoice`.
Interactive lookup checks one invoice through store-backed gates. A bounded
background sweep may run after route responses. An optional scheduler can call
`openreceive poll --once`.

There is no required worker, NWC notification listener, webhook bridge, SSE
route, or in-memory event bus in the default v0.1-v2 contract.

## Consequences

- Browser state updates through backend lookup polling.
- Wallet load is bounded by per-invoice cooldown and a global token bucket in
  the durable store.
- Recovery works across process restarts because the store is the coordination
  point.
