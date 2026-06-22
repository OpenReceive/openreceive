# ADR-0002: No Frontend NWC

## Status

Accepted for v0.1.

## Context

NWC connection strings are wallet secrets. Browser, mobile, and static frontend
apps cannot safely hold wallet credentials for your app.

## Decision

OpenReceive does not support pure-frontend live checkout. Frontend packages
render display-safe invoice data and call your backend routes. Invoice
creation, NWC access, lookup, recovery polling, and app settlement actions stay
server-side.

## Consequences

- Browser packages must not depend on NWC credentials.
- Mobile apps call your payment backend.
- Static sites need a small API, durable backend, and normal app server or
  optional scheduler.
- Secret scanning checks for accidental NWC exposure.
