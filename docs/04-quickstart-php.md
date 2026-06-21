# PHP Quickstart Status

OpenReceive does not have a PHP package yet. This page records the intended PHP
server shape for future Laravel, Symfony, or plain PHP integrations.

Use the Node framework quickstart for the current working reference path:

```text
docs/01-quickstart-node.md
```

## Planned Shape

A PHP integration should mount into the merchant's application and use the
application's existing auth, database, queue, and deployment model. The package
should own two backend entry points: a poll command/job for settlement polling
and restart recovery, and a listen command/job for payment_received
notifications. Developers should run both; polling remains the fallback when
notifications do not arrive.
The PHP package should ship OpenReceive migrations/models for the target
framework; host apps should not hand-roll invoice/idempotency tables. The host
app supplies metadata references and settlement hooks.

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

Never expose `OPENRECEIVE_NWC` through Blade/Twig templates, public env vars,
frontend bundles, mobile apps, logs, exception pages, or analytics payloads.

Frontend code receives only display-safe invoice data and authorized status or
event URLs. A client-supplied settled flag, preimage, or notification must not
run a merchant settlement action.

## Conformance

Future PHP packages should use the same schemas, test vectors, deterministic
mock wallet, and live wallet profile smoke flow as the JS reference path.

Do not publish PHP packages until they prove:

- canonical idempotency replay and conflict behavior
- `make_invoice` and `lookup_invoice` request validation
- receive-only API shape with no send-payment helpers
- settlement detection from backend lookup only
- duplicate notification safety
- secret redaction in errors and logs
