# PHP Quickstart Status

First step: get a read-only NWC code so your app can create invoices and check
payment status from your server. You can use any NWC provider and switch
providers at any time. Start here:
https://openreceive.org/get_a_nwc_code_to_receive_payments

OpenReceive does not have a PHP package yet. This page records the intended PHP
server shape for future Laravel, Symfony, or plain PHP integrations.

Use the Node framework quickstart for the current working reference path:

```text
docs/01-quickstart-node.md
```

## Planned Shape

A PHP integration mounts into your application and uses the app's existing auth
and deployment model. The OpenReceive package would provide route handlers,
package-owned KV persistence selected by `OPENRECEIVE_STORE`, and an optional
one-shot poll command/job for platform schedulers. There is no listener or
required worker process. The app supplies metadata references and settlement
hooks while OpenReceive handles its invoice/idempotency rows.

Expected PHP pieces:

- Laravel or Symfony route/controller helpers under `/openreceive/v1`
- server-side receive-only NWC configuration
- package-owned KV storage for invoices, idempotency, lookup gates, and
  settlement-action state
- scheduler jobs for one-shot poll recovery
- Livewire, Inertia, or template-driven browser updates backed by lookup polling
- idempotent settlement actions after backend wallet lookup confirms settlement

## Security Boundary

Keep `OPENRECEIVE_NWC` out of Blade/Twig templates, public env vars, frontend
bundles, mobile apps, logs, exception pages, and analytics payloads.

Frontend code receives only display-safe invoice data and authorized status
responses. Your settlement actions run from backend wallet verification,
not from client-supplied settled flags, preimages, or passive notifications.

## Conformance

PHP packages use the same schemas, test vectors, deterministic mock wallet, and
live wallet profile smoke flow as the JS reference path.

Before publishing a PHP package, cover:

- canonical idempotency replay and conflict behavior
- `make_invoice` and `lookup_invoice` request validation
- receive-only API shape with no send-payment helpers
- settlement detection from backend lookup only
- duplicate notification safety
- secret redaction in errors and logs
