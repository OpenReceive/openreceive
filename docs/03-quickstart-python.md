# Python Quickstart Status

OpenReceive does not have a Python package yet. This page records the intended
Python server shape for future FastAPI, Django, Flask, or Starlette work.

Use the Node and Express quickstart for the current working reference path:

```text
docs/01-quickstart-node.md
```

## Planned Shape

A Python integration should install into the merchant's existing server app.
The app should own auth, invoice storage, order lookup, fulfillment, and worker
runtime.

Expected Python pieces:

- FastAPI or Django route handlers under `/openreceive/v1`
- server-side receive-only NWC configuration
- database-backed invoice and idempotency storage
- Celery, RQ, Dramatiq, APScheduler, or framework-native polling workers
- SSE, WebSocket, HTMX, or template-driven checkout updates
- idempotent fulfillment after backend wallet lookup proves settlement

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
