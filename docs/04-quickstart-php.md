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

A PHP integration mounts into your application and uses the app's
existing auth, database, queue, and deployment model. The OpenReceive package
would provide a poll command/job for settlement polling and restart recovery
plus a listen command/job for `payment_received` notifications. Run both;
polling remains the fallback when notifications do not arrive.
The PHP package would ship OpenReceive migrations/models for the target
framework. The app supplies metadata references and settlement hooks while
OpenReceive handles its invoice/idempotency rows.

Expected PHP pieces:

- Laravel or Symfony route/controller helpers under `/openreceive/v1`
- server-side receive-only NWC configuration
- package-owned database tables for invoices, idempotency keys, lifecycle
  state, and settlement action state
- queue workers or scheduler jobs for polling, expiry verification, and
  notification listening
- SSE, Mercure, Livewire, Inertia, or template-driven browser updates
- idempotent settlement actions after backend wallet lookup confirms settlement

## Security Boundary

Keep `OPENRECEIVE_NWC` out of Blade/Twig templates, public env vars, frontend
bundles, mobile apps, logs, exception pages, and analytics payloads.

Frontend code receives only display-safe invoice data and authorized status or
event URLs. Your settlement actions run from backend wallet verification,
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
