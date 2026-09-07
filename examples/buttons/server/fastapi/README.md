# Buy a Button — FastAPI

The button shop on FastAPI + SQLite, with the packaged React `<Checkout>` and
nothing else in the payment column. This is the **minimal Python host**: the
smallest correct integration of a packaged checkout against
`openreceive_router` — the Fastify stack's twin, with `uv run uvicorn` where
that one has `node`.

```sh
npm run demo fastapi     # Docker, :3007
npm run dev -w @openreceive/example-buttons-fastapi   # Vite + uvicorn, :3007
```

## What is different about this stack

The catalog, the cart, the receipt and the recent-orders feed are the *same
React components* every other stack renders — `examples/buttons/shared/client/`,
imported by relative path, not copied. node-express already proves that the
four wrapper packages all mount the same checkout, so this stack does not
repeat the tab strip: it plugs the packaged `<Checkout>` into `ShopPanel`'s
`renderCheckout` seam and stops there.

What changes is the **server**, and the lines that matter are in
`server/main.py`:

- **`openreceive_router(host, engine=engine, rate_limiting=True)`**, included
  with `app.include_router(router, prefix="/openreceive")`. The engine is the
  shop's own SQLAlchemy `Engine`; OpenReceive's two tables live in the same
  SQLite file as the shop's four, rendered from `payments_schema_sql` at boot.
- **`FastAPI(lifespan=openreceive_lifespan(host, engine=engine))`** runs the
  receive-only wallet preflight at startup and stops the process on a bad or
  spend-capable `NWC_URI` — the deploy fails instead of the first payer.
- **`authorize` receives the Starlette `Request`.** The order must belong to
  the browser whose signed `shop_user_id` cookie is on it; possession of an
  order id is a claim, not proof.
- **`on_paid` runs on `settlement.connection`** — the settlement transaction's
  own SQLAlchemy connection — so the guarded `awaiting_payment → paid` UPDATE
  commits together with the payment record.
- **No CSRF layer.** FastAPI ships none; the engine's `Sec-Fetch-Site:
  cross-site` refusal is the protection, exactly as on Express and Fastify.

## The server

| file | what it owns |
| --- | --- |
| `server/shop.py` | the four tables, the signed visitor cookie, `Store` (catalog, orders, feed), the guarded paid transition, the two payloads |
| `server/main.py` | the FastAPI app: the three hooks, the mounted router, the five shop routes, the artwork mount, the built SPA |
| `server/testkit.py` | the `/__testkit` control routes, live only in testkit mode |

**In development, Vite is the front door.** `vite.config.ts` spawns
`uv run uvicorn server.main:app` on an internal port (3107, or
`OPENRECEIVE_FASTAPI_PORT`) and proxies the API paths (`/shop`,
`/openreceive`, `/images`, `/__testkit`) to it, serving the SPA itself. One
URL, one command, the same host code production runs. In production the
FastAPI app serves the built `dist/` with `index.html` as the SPA fallback,
so `/checkout/:reference` survives a reload.

**The database survives a restart.** Orders, users and products outliving the
process is the subject of this demo. The file lives in
`examples/buttons/.data/` (gitignored), and `OPENRECEIVE_DEMO_DB` overrides the
directory so hermetic runs point at a temp dir. `DATABASE_URL` switches the
whole shop — engine tables included — onto Postgres.

## Settlement is polled, not pushed

The Rails stack pushes settlement over ActionCable. This one does not: the
checkout keeps its own poll loop and the feed refreshes every thirty seconds.
Every OpenReceive call also runs the durably gated opportunistic reconcile, so
a payer who closed the page settles on the next call that wins the gate — no
background worker required. `openreceive notifications --app server.asgi:app`
is the optional NWC-02 listener if you want orders paid the moment the wallet
sees them.

## Testkit mode

`DEMO_WALLET=testkit` boots against the in-memory `openreceive.testing` fakes
— no `NWC_URI`, no network — and mounts the `/__testkit` control routes the
Playwright suite in `tests/e2e/` drives (`OPENRECEIVE_E2E_STACK=fastapi`). In
every other mode the whole `/__testkit` prefix answers a JSON 404. `bin/ci`
runs the demo's own tests in that mode.

## The boundary

**The browser never receives your NWC code.** `NWC_URI` is read by the server
at boot and never reaches a bundle, a log or an asset. The payer's browser
talks to the included OpenReceive routes; the wallet connection stays on this
side of them.

Persistence is host-owned in the same way. The shop's four tables and the
engine's two live in ONE local SQLite database that this application opens —
OpenReceive brings no datastore of its own, and `on_paid` writes the order
transition through the connection it hands the host.
