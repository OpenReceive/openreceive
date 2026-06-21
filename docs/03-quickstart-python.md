# Python Quickstart Status

First step: get a read-only NWC code so your app can create invoices and check
payment status from your server. You can use any NWC provider and switch
providers at any time. Start here:
https://openreceive.org/get_a_nwc_code_to_receive_payments

OpenReceive does not have a Python package yet. This page records the intended
Python server shape for future FastAPI, Django, Flask, or Starlette work.

Use the Node framework quickstart for the current working reference path:

```text
docs/01-quickstart-node.md
```

## Planned Shape

A Python integration installs into your existing server app. The app
keeps its existing auth, order lookup, settlement actions, and worker runtime.
The OpenReceive package would provide a poll command/task for settlement
polling and restart recovery plus a listen command/task for
`payment_received` notifications. Deploy those commands as backend worker
processes next to the web process. Run both; polling remains the fallback when
notifications do not arrive.
The Python package would ship the OpenReceive persistence model and migration
path for the target framework or ORM. The app supplies metadata references and
settlement hooks while OpenReceive handles its invoice/idempotency rows.

Expected Python pieces:

- FastAPI or Django route handlers under `/openreceive/v1`
- server-side receive-only NWC configuration
- package-owned database-backed invoice and idempotency storage
- Celery, RQ, Dramatiq, APScheduler, or framework-native polling and
  notification workers
- SSE, WebSocket, HTMX, or template-driven checkout updates
- idempotent settlement actions after backend wallet lookup proves settlement

## Security Boundary

Keep NWC credentials out of browser JavaScript, mobile apps, templates, static
files, logs, error responses, and source maps.

Python handlers return only display-safe checkout data to clients.
Notification events are hints; settlement authority remains backend
`lookup_invoice`.

## Conformance

Python packages use the shared schemas, vectors, OpenAPI contract, and
deterministic mock wallet. Before publishing a package, cover:

- create and refresh idempotency
- amount and metadata validation
- error normalization
- duplicate notification replay safety
- polling expiry behavior
- backend-only settlement verification

Live wallet profile tests with a receive-only NWC secret remain separate from
mock-wallet conformance tests.
