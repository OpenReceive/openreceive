# ADR-0002: No Frontend NWC

## Status

Accepted for v0.1.

## Context

Receive-only NWC codes are server-only. Browser, mobile, and static frontend apps
cannot safely hold the NWC code for your app.

## Decision

OpenReceive does not support pure-frontend live checkout. Frontend packages
render display-safe invoice data and call your backend routes. Invoice
creation, NWC access, lookup, recovery polling, and app settlement actions stay
server-side.

## Consequences

- Browser packages must not depend on receive-only NWC codes.
- Mobile apps call your payment backend.
- Static sites need a small API, durable backend, and normal app server or
  optional scheduler.
- Secret scanning checks for accidental receive-only NWC code exposure.
