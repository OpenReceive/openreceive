# Buy a Button — Next.js

The button shop on the Next.js App Router + SQLite.

```sh
npm run demo buttons-nextjs      # Docker, :3002
npm run dev -w @openreceive/example-buttons-nextjs-fullstack   # :3002
```

## The same shop as Rails, on a different server

This stack and the Rails one render an **identical** shop: both plug the
keystone-driven `CheckoutStage` into `ShopPanel`'s `renderCheckout` seam, and
every component above and below it comes from
`examples/buttons/shared/client/`. node-express is the stack that plugs in
something else — the packaged `<Checkout>` behind four framework tabs.

## The routes are wrappers

Every handler under `src/app/shop/` is three lines around one of the five
framework-free functions in `examples/buttons/shared/server-node/shop-routes.ts`
— the same functions the Express stacks mount. `src/server/shop.ts` is the
adapter (a Web `Request` in, a Web `Response` out) and nothing else.

| route | handler |
| --- | --- |
| `GET /shop/bootstrap` | `bootstrap` |
| `POST /shop/orders` | `createOrder` |
| `GET /shop/orders/:reference` | `showOrder` |
| `GET /shop/orders/:reference/downloads/:sku` | `download` |
| `GET /shop/recent_orders` | `recentOrders` |
| `GET|POST /openreceive/*` | the shipped `openReceiveNextHandlers` |

`GET /images/:file` serves the catalog thumbnails from
`examples/buttons/images` — a route rather than a `public/` folder, because
copying the six webp files into this stack is exactly what the shared layout
exists to prevent.

**The bootstrap payload is not server-rendered**, even though Next could. It
mints the visitor and sets a signed cookie, and a server component cannot set
one during render — so the client fetches `/shop/bootstrap` exactly as the
Express stack does.

## Two things this stack needs that the others do not

- **`next` 16.** Next vendors its own React for the App Router, and 15.5's
  vendored canary does not export `useEffectEvent`, which `@mantine/core` v9
  calls from `ScrollArea`. On 15.5 the shop renders and then dies the moment a
  scrollable Mantine component mounts.
- **Singletons on `globalThis`.** A module-level `let` is re-evaluated when
  Turbopack reloads the server graph in dev, which opens a second SQLite handle
  on the same file; minted attempts then fail to persist and nothing points at
  the reload. See the note in `src/server/shop.ts`.

## Settlement is polled

There is no long-lived process to own a reconciler on a serverless runtime, so
every OpenReceive call runs the durably gated opportunistic reconcile and the
checkout keeps its own poll loop. A payer who closed the page settles on the
next call that wins the gate.

`DEMO_WALLET=testkit` boots against the in-memory fakes and serves the
`/__testkit` control routes. (The folder is named `%5F%5Ftestkit` — the App
Router treats a leading `_` as a private folder and would never register the
route.)

## The boundary

**The browser never receives your NWC code.** `NWC_URI` is read by the server
at boot and never reaches a bundle, a log or an asset. The payer's browser
talks to the mounted OpenReceive routes; the wallet connection stays on this
side of them.

Persistence is host-owned in the same way. The shop's four tables and the
engine's two live in ONE local SQLite database that this application opens —
OpenReceive brings no datastore of its own, and `onPaid` writes the order
transition through the transaction it hands the host.
