# ADR-0002: No Frontend NWC

## Status

Accepted for v0.1.

## Context

NWC connection strings are wallet secrets. Browser, mobile, and static frontend
apps cannot safely hold wallet credentials for your app.

## Decision

OpenReceive does not support pure-frontend live checkout. Frontend packages
render display-safe invoice data, subscribe to passive events, and call
your backend routes. Invoice creation, NWC access, lookup, polling,
notification handling, and app settlement actions stay server-side.

## Consequences

- Browser packages must not depend on NWC credentials.
- Mobile apps call your payment backend.
- Static sites need a small API, durable backend, cron/polling owner, or normal
  app server.
- Secret scanning checks for accidental NWC exposure.
