# @openreceive/http

Framework-agnostic HTTP handler for OpenReceive. It ships rodauth-style routes that operate on the
host's OpenReceive `service` (the host owns the DB and wallet), while authentication, server-side
pricing, and rate limiting stay the host's — injected as hooks.

The package exposes one factory:

```ts
import { createOpenReceiveHttpHandler } from "@openreceive/http";

const handler = createOpenReceiveHttpHandler({ service, authorize, getOrderAmount });

// `handler` is a Web-standard Fetch handler: (request: Request) => Promise<Response>.
// It also carries `handler.prefix` and a `handler.handle` alias.
const response = await handler(request);
```

Any runtime with the Fetch `Request`/`Response` globals (Node 20+, Deno, Bun, edge functions) can
mount it; the framework adapters (Express, Fastify, Next, …) and the Ruby engine are thin wrappers
over this same handler.

## Routes (mounted under `prefix`, default `/openreceive`)

| Method | Path | Tier | Action |
| --- | --- | --- | --- |
| POST | `/checkouts` | 1 | `checkout.create` |
| POST | `/orders/{order_id}` | 2/3 | `order.read` / `swap.*` by body `action` |
| GET | `/checkouts/{checkout_id}` | 2 | `checkout.read` |
| GET | `/orders/{order_id}/swap-options` | 2 | `swap.options` |
| GET | `/rates` | 1 | public |
| POST | `/admin/sweep` | 3 | `invoice.sweep` (fails closed) |

Bodies are POST + JSON with snake_case fields; the order route is an action multiplexer. Errors are
JSON `{ code, message, retryable?, request_id?, details? }` with `code` drawn from the shared
`OpenReceiveErrorCode` enum. Every response also carries an `X-Request-Id` header.

## Golden test vectors

`spec/test-vectors/http-golden/*.json` are the cross-adapter / cross-language parity oracle. Each
vector is `{ name, request: { method, path, headers?, body? }, expected: { status, body_includes?,
error_code? } }`. Expectations are pinned to HTTP status, stable fields, and error codes only —
never volatile ids or timestamps.

This handler's test suite (`tests/v0.1/http-handler.test.mjs`) loads and asserts every vector, and
the framework adapters and the Ruby engine are expected to run the same vectors so that all
implementations stay behaviorally identical on the wire.
