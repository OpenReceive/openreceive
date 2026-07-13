# @openreceive/http

Framework-agnostic HTTP handler for OpenReceive. It ships rodauth-style routes that operate on the
host's OpenReceive `service` (the host owns the DB and wallet), while authentication, server-side
pricing, and rate limiting stay the host's — injected as hooks.

The package exposes one factory:

```ts
import { createOpenReceiveHttpHandler } from "@openreceive/http";

// `service` and `prepareCheckout` are required. POST /prepare is the sole price authority.
const prepareCheckout = async ({ body }) => {
  const cart = validateCart(body);
  return {
    amount: { currency: "USD", value: cart.totalUsd },
    summary: cart.summary,
  };
};

const handler = createOpenReceiveHttpHandler({
  service,
  authorize, // optional; default gates Tier 2 on the order token and fails Tier 3 closed
  prepareCheckout,
});

// `handler` is a Web-standard Fetch handler: (request: Request) => Promise<Response>.
const response = await handler(request);
```

`POST {prefix}/prepare` calls your hook and persists the amount. `POST {prefix}/checkouts`
accepts `{ order_id, memo?, description_hash?, metadata? }` only — client `amount` / `sats` /
`usd` are rejected with 400. Create without prepare → 404.

Any runtime with the Fetch `Request`/`Response` globals (Node 20+, Deno, Bun, edge functions) can
mount it; the framework adapters (Express, Fastify, Next, …) and the Ruby engine are thin wrappers
over this same handler.

## Routes (mounted under `prefix`, default `/openreceive`)

| Method | Path | Tier | Action |
| --- | --- | --- | --- |
| POST | `/prepare` | 1 | `checkout.prepare` |
| POST | `/checkouts` | 1 | `checkout.create` |
| GET | `/checkouts/{checkout_id}` | 2 | `checkout.read` |
| POST | `/orders/{order_id}` | 2 | `order.read` / `swap.*` |
| GET | `/orders/{order_id}/summary` | 1 | `order.summary` |
| GET | `/orders/{order_id}/swap-options` | 2 | `swap.options` |
| GET | `/rates` | 1 | public |
| POST | `/admin/sweep` | 3 | `invoice.sweep` (fails closed) |

See `docs/guides/quickstart-node.md` and `docs/guides/authorization.md`.
Contributor route contract: `docs/internal/shipped-routes.md`.
