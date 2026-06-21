# Python Quickstart Status

OpenReceive does not have a Python package yet. This page records the intended
Python server shape for future FastAPI, Django, Flask, or Starlette work.

Use the Node framework quickstart for the current working reference path:

```text
docs/01-quickstart-node.md
```

## Planned Shape

A Python integration should install into the merchant's existing server app.
The app should own auth, invoice storage, order lookup, merchant settlement
actions, and worker runtime. The package should own two backend entry points:
a poll command/task for settlement polling and restart recovery, and a listen
command/task for payment_received notifications. Deploy poll and listen as
separate backend processes or worker roles, not as threads inside the web
request path. Developers should run both; polling remains the fallback when
notifications do not arrive.
The Python package should ship the OpenReceive persistence model and migration
path for the target framework or ORM; host apps should not create their own
invoice/idempotency tables. The host app supplies metadata references and
settlement hooks.

Expected Python pieces:

- FastAPI or Django route handlers under `/openreceive/v1`
- server-side receive-only NWC configuration
- package-owned database-backed invoice and idempotency storage
- Celery, RQ, Dramatiq, APScheduler, or framework-native polling and
  notification workers
- SSE, WebSocket, HTMX, or template-driven checkout updates
- idempotent settlement actions after backend wallet lookup proves settlement

## Security Boundary

Do not put NWC credentials in browser JavaScript, mobile apps, templates,
static files, logs, error responses, or source maps.

Python handlers should return only display-safe checkout data to clients.
Notification events are hints; settlement authority remains backend
`lookup_invoice`.

## Conformance

Future Python packages should consume the shared schemas, vectors, OpenAPI
contract, and deterministic mock wallet. Before any package is published, it
must prove:

- create and refresh idempotency
- amount and metadata validation
- error normalization
- duplicate notification replay safety
- polling expiry behavior
- backend-only settlement verification

Live wallet profile tests with a receive-only NWC secret remain separate from
mock-wallet conformance tests.
