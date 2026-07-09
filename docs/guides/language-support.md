# Language Support

The current working reference path is Node plus browser checkout packages. Use
[Node Framework Quickstart](quickstart-node.md) for copy-pasteable integration
code. Rails is a second, vector-conformant settlement engine — see
[Rails Quickstart](quickstart-rails.md).

## Node

Node is the v0.1 supported path:

- `@openreceive/node` / `openreceive/node` exposes the server-only service
  (`createOpenReceive`, `startSweeper`, …).
- `@openreceive/http` plus `@openreceive/express` | `fastify` | `next` (also
  `openreceive/express|fastify|next`) ship the HTTP routes. `getCheckoutAmount` is
  required; the create body never carries a client price.
- `@openreceive/browser` creates display-safe invoices and browser helpers.
- `@openreceive/react` and `@openreceive/elements` (also `openreceive/react`)
  render checkout UI.

## Rails / Ruby

Ruby is a full second settlement engine:

- `openreceive` — dependency-free core (money math, settlement, tokens).
- `openreceive-server` — Service, stores, Rack app (`get_checkout_amount` required).
- `openreceive-rails` — mountable engine; configure `get_checkout_amount` in the
  initializer. Controllers inherit your `parent_controller`.

Node adapters and the Rails engine stay byte-equal on the OpenAPI contract and
HTTP golden vectors.

## Python

There is no Python package yet. Future FastAPI, Django, Flask, or Starlette
work should keep `OPENRECEIVE_NWC` server-side, mount or mirror the same route
contract (host-owned orders + `getCheckoutAmount`-equivalent pricing), use
OpenReceive invoice storage, and run fulfillment only from a server-side
payment-verified hook.

## PHP

There is no PHP package yet. Future Laravel, Symfony, or plain PHP work should
follow the same server-owned model: your app keeps auth, orders, and
fulfillment, while OpenReceive owns invoice creation, payment verification,
recovery, and fulfillment delivery state.
