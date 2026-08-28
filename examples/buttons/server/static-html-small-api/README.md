# Buy a Button — static HTML + a small API

The button shop with **no framework at all**.

```sh
npm run demo buttons-static      # Docker, :3001
npm run dev -w @openreceive/example-buttons-static-html   # Vite, :3001
```

## Why this demo exists

To prove the pattern is not React-specific. The persistence, the trust
boundary, the signed-cookie identity and the checkout all work against
hand-written DOM — so the shop UI here is a **second implementation**, in
`examples/buttons/shared/client-vanilla/main.ts`, about 400 lines of plain
TypeScript.

**It has full parity**: catalog, cart, checkout, receipt with downloads, and
the recent-orders tab with its "You" badge. Dropping the feed would have
dropped the feature this whole version of the demo is about.

## What is *not* duplicated

Only the DOM and the state machine are rewritten. Everything else is the same
file the React clients use:

| shared | what it gives this demo |
| --- | --- |
| `../shop.css` | the whole design. The vanilla DOM emits the same `or-` class names, which is why this demo looks like the same product rather than a second one |
| `../shop-types.ts` | the wire types, `formatUsdCents`, `relativeTime`, `pluralize`, `summarizeItems` |
| `../http.ts` | `getJson` / `postJson`, including the `fresh` revalidation rule the feed's ten-second cache depends on |
| `../bootstrap.ts` | the bootstrap fetch |
| `../server-node/` | the entire server, shared with node-express |

`client-vanilla/shop-vanilla.css` adds only what Mantine was providing on the
React side: buttons, the quantity stepper, the tab strip, an alert and a link.

**It must never import `../client/`.** That is React, and the split is meant to
make a wrong import visible in the diff rather than at build time — which is
also why `@mantine/*` and `mobx*` are absent from this workspace's
`package.json`, where such an import would simply fail to resolve.

## The payment step

`<openreceive-checkout reference prefix>` — the packaged custom element from
`@openreceive/elements`. It creates the checkout against the mounted router,
polls, and drives swaps itself, which is why this is the smallest of the four
UIs: there is no wizard to build.

`prefix` is the element's only URL input and comes from the bootstrap payload,
so the mount path lives on the server rather than in a second copy in the
bundle.

## The server

`examples/buttons/shared/server-node/express-app.ts`, identical to
node-express except that per-IP rate limiting is left **off** in this minimal
variant. The database is SQLite and it survives a restart.

## The boundary

**The browser never receives your NWC code.** `NWC_URI` is read by the server
at boot and never reaches a bundle, a log or an asset. The payer's browser
talks to the mounted OpenReceive routes; the wallet connection stays on this
side of them.

Persistence is host-owned in the same way. The shop's four tables and the
engine's two live in ONE local SQLite database that this application opens —
OpenReceive brings no datastore of its own, and `onPaid` writes the order
transition through the transaction it hands the host.
