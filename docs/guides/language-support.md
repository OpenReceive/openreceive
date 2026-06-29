# Language Support

The current working reference path is Node plus browser checkout packages. Use
[Node Framework Quickstart](quickstart-node.md) for copy-pasteable integration
code.

## Node

Node is the v0.1 supported path:

- `@openreceive/node` exposes server-only service methods for app-owned
  controllers.
- `@openreceive/browser` creates display-safe invoices and browser helpers.
- `@openreceive/react` and `@openreceive/elements` render checkout UI.

## Rails

There is no active Rails adapter package. The stale invoice-route adapter was
removed while the public API moved to the checkout model. Future Rails work
should expose app-owned checkout controllers that call the same server-side
checkout/order functions as the Node reference path.

## Python

There is no Python package yet. Future FastAPI, Django, Flask, or Starlette
work should keep `OPENRECEIVE_NWC` server-side, expose app-owned checkout
routes, use OpenReceive invoice storage, and run fulfillment only from a
server-side payment-verified hook.

## PHP

There is no PHP package yet. Future Laravel, Symfony, or plain PHP work should
follow the same server-owned model: your app keeps auth and fulfillment, while
OpenReceive owns invoice creation, payment verification, recovery, and
fulfillment delivery state.
