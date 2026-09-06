# Buy a Button — Fastify

The button shop on Fastify + SQLite, with the packaged React `<Checkout>` and
nothing else in the payment column. This is the **minimal host**: the smallest
correct integration of a packaged checkout against a Fastify-registered
OpenReceive plugin.

```sh
npm run demo fastify     # Docker, :3004
npm run dev -w @openreceive/example-buttons-fastify   # Vite, :3004
```

## What is different about this stack

The catalog, the cart, the receipt and the recent-orders feed are the *same
React components* every other stack renders — `examples/buttons/shared/client/`,
imported by relative path, not copied. node-express already proves that the
four wrapper packages all mount the same checkout, so this stack does not
repeat the tab strip: it plugs the packaged `<Checkout>` into `ShopPanel`'s
`renderCheckout` seam and stops there.

What changes is the **server**, and the three lines that matter are in
`examples/buttons/shared/server-node/fastify-app.ts`:

- **Plugin registration with a prefix.** Express mounts a router with
  `app.use(openReceiveExpress(...))`; Fastify registers a plugin:
  `await app.register(openReceiveFastify, { ..., prefix: "/openreceive" })`.
  The prefix goes to `register()` so Fastify scopes the plugin's catch-all to
  it, and the OpenReceive routes live directly under `/openreceive`.
- **`Fastify({ trustProxy: true })`.** The Fastify spelling of Express's
  `app.set("trust proxy", 1)`. Behind a reverse proxy it makes `request.ip`
  the payer rather than the proxy, so the per-IP invoice cap (`rateLimiting:
  true`) counts the right thing, and the identity cookie's `Secure` flag
  follows the original scheme.
- **No body parser.** Fastify parses JSON itself; there is no
  `app.use(express.json())` equivalent, and the plugin reads `request.body`.

Host-route refusals go through `setErrorHandler` and `sendHostRouteError`
from `@openreceive/fastify`, which renders the same snake_case error shape the
mounted OpenReceive routes emit.

## The server

`examples/buttons/shared/server-node/` — shared with the Express stacks and
(apart from the framework glue) with `nextjs-fullstack` too:

| file | what it owns |
| --- | --- |
| `migrations.ts` | five numbered steps, tracked in `schema_migrations` |
| `store.ts` | the tables, `normalizedLines`, the guarded transition |
| `cookie.ts` | the signed identity cookie |
| `shop-routes.ts` | the five handlers, framework-free |
| `openreceive-config.ts` | `authorize`, `amountFor`, `onPaid` — the whole bridge |
| `fastify-app.ts` | the Fastify host: the five routes, the artwork mount, the registered plugin |

**In development, Vite is the front door.** A Fastify instance is not a
Connect middleware, so the dev server cannot `use()` it the way the Express
stacks do. Instead `vite.config.ts` hands the API paths (`/shop`,
`/openreceive`, `/images`, `/__testkit`) to `app.routing` — Fastify's router
as a plain `(req, res)` function — and serves the SPA itself. One port, one
process, the same host code production runs. In production `@fastify/static`
serves the built bundle with `index.html` as the SPA fallback, so
`/checkout/:reference` survives a reload.

**The database survives a restart.** Orders, users and products outliving the
process is the subject of this demo. The file lives in
`examples/buttons/.data/` (gitignored), and `OPENRECEIVE_DEMO_DB` overrides the
directory so hermetic runs point at a temp dir.

## Settlement is polled, not pushed

The Rails stack pushes settlement over ActionCable. This one does not: the
checkout keeps its own poll loop and the feed refreshes every thirty seconds.
Every OpenReceive call also runs the durably gated opportunistic reconcile, so
a payer who closed the page settles on the next call that wins the gate — no
background worker required.

## Testkit mode

`DEMO_WALLET=testkit` boots against the in-memory `@openreceive/testkit` fakes
— no `NWC_URI`, no network — and mounts the `/__testkit` control routes the
Playwright suite in `tests/e2e/` drives (`OPENRECEIVE_E2E_STACK=fastify`). In
every other mode the whole `/__testkit` prefix answers 404.

## The boundary

**The browser never receives your NWC code.** `NWC_URI` is read by the server
at boot and never reaches a bundle, a log or an asset. The payer's browser
talks to the registered OpenReceive routes; the wallet connection stays on this
side of them.

Persistence is host-owned in the same way. The shop's four tables and the
engine's two live in ONE local SQLite database that this application opens —
OpenReceive brings no datastore of its own, and `onPaid` writes the order
transition through the transaction it hands the host.
