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
keeps its existing auth, order lookup, and settlement actions. The OpenReceive
package would mount routes, provide package-owned KV persistence selected by
`OPENRECEIVE_STORE`, and expose an optional one-shot poll command for platform
schedulers. There is no listener or required worker process.
The app supplies metadata references and settlement hooks while OpenReceive
handles its invoice/idempotency rows.

Expected Python pieces:

- FastAPI or Django route handlers under `/openreceive/v1`
- server-side receive-only NWC configuration
- package-owned KV invoice and idempotency storage
- APScheduler, cron, or platform scheduled one-shot poll support
- template, HTMX, or API-driven checkout updates backed by lookup polling
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
