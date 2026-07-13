# Language Support

The current working reference path is Node plus browser checkout packages. Use
[Node Framework Quickstart](quickstart-node.md) for copy-pasteable integration
code. Rails is a second settlement engine — see
[Rails Quickstart](quickstart-rails.md).

## Node

Node is the v0.1 supported path:

- `@openreceive/node` / `openreceive/node` exposes the server-only service
  (`createOpenReceive`, `startSweeper`, …).
- `@openreceive/http` plus `@openreceive/express` | `fastify` | `next` (also
  `openreceive/express|fastify|next`) ship the HTTP routes. `prepareCheckout` is
  required; POST `/prepare` is the sole price authority and the create body
  never carries a client price.
- `@openreceive/browser` creates display-safe invoices and browser helpers.
- `@openreceive/react` and `@openreceive/elements` (also `openreceive/react`)
  render checkout UI.

## Rails / Ruby

Ruby is a full second settlement engine:

- `openreceive` — core money math and settlement.
- `openreceive-server` — Service, stores, Rack app (`prepare_checkout` required).
- `openreceive-rails` — mountable engine; configure `prepare_checkout` in the
  initializer. Controllers inherit your `parent_controller`.

Node and Rails stay on the same payment contract for hosts.

## Python

There is no Python package yet. Future FastAPI, Django, Flask, or Starlette
work should keep `OPENRECEIVE_NWC` server-side, mount or mirror the same host
model (`prepareCheckout`-equivalent pricing on prepare + create from persist), use
OpenReceive invoice storage, and run fulfillment only from a server-side
payment-verified hook.

## PHP

There is no PHP package yet. Future Laravel, Symfony, or plain PHP work should
follow the same server-owned model: your app keeps auth, orders, and
fulfillment, while OpenReceive owns invoice creation, payment verification,
recovery, and fulfillment delivery state.
