# Buy a Button — Express

The button shop on Express + SQLite, with the packaged checkout in **four
frameworks**.

```sh
npm run demo buttons-express     # Docker, :3000
npm run dev -w @openreceive/example-buttons-node-express   # Vite, :3000
```

## What is different about this stack

The catalog, the cart, the receipt and the recent-orders feed are the *same
React components* Rails and Next.js render — `examples/buttons/shared/client/`,
imported by relative path, not copied.

The **payment screen is the one thing that differs**, and deliberately so.
`ShopPanel` takes a `renderCheckout` prop; Rails and Next.js plug in the
keystone-driven `CheckoutStage`, and this stack plugs in the packaged
`<Checkout>` behind a React / Vue / Svelte / Angular tab strip. That is what
node-express is for: proving the four wrapper packages all mount the same
checkout against the same mounted router.

The tab strip lives *inside* the seam rather than above the panel, because
choosing a framework is a statement about the payment screen and means nothing
on the catalog or the receipt.

## The server

`examples/buttons/shared/server-node/` — shared with
`static-html-small-api`, and (apart from the Express glue) with
`nextjs-fullstack` too:

| file | what it owns |
| --- | --- |
| `migrations.ts` | five numbered steps, tracked in `schema_migrations` |
| `store.ts` | the tables, `normalizedLines`, the guarded transition |
| `cookie.ts` | the signed identity cookie |
| `shop-routes.ts` | the five handlers, framework-free |
| `openreceive-config.ts` | `authorize`, `amountFor`, `onPaid` — the whole bridge |
| `express-app.ts` | the Express host this stack and static-html share |

**The database survives a restart.** Hello Fruit wiped its SQLite file on every
boot, which was right for a disposable checkout surface and wrong here: orders,
users and products outliving the process is the subject of this demo. The file
lives in `examples/buttons/.data/` (gitignored), and `OPENRECEIVE_DEMO_DB`
overrides the directory so hermetic runs point at a temp dir.

## Settlement is polled, not pushed

The Rails stack pushes settlement over ActionCable. This one does not: the
checkout keeps its own poll loop and the feed refreshes every thirty seconds.
Both land in the same idempotent store methods, so the only difference is
latency. Every OpenReceive call also runs the durably gated opportunistic
reconcile, so a payer who closed the page settles on the next call that wins
the gate — no background worker required.

## Testkit mode

`DEMO_WALLET=testkit` boots against the in-memory `@openreceive/testkit` fakes
— no `NWC_URI`, no network — and mounts the `/__testkit` control routes the
Playwright suite in `tests/e2e/` drives. In every other mode the whole
`/__testkit` prefix answers 404.
