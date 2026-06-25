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

Rails support is initial proof work. The `openreceive` and `openreceive-rails`
Ruby packages live in this repository with tests, route helpers, generated
tasks, OpenReceive SQLite storage, Hotwire partials, and a Rails Hotwire demo
skeleton.

Treat Rails as experimental until the Rails smoke and live-wallet proof gaps
are closed. The active demo is:

```sh
npm run demo rails
```

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
