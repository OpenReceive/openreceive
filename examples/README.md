# OpenReceive examples

One app lives here: [`hello-fruit/`](hello-fruit), the full fruit-sticker shop,
built four times over four server stacks. Start with it to see a complete
checkout: catalog, cart, currency picker, Lightning + swap rails,
resume-after-refresh, post-pay delivery.

For the smallest possible integration, follow the
[Node quickstart](../docs/guides/quickstart-node.md) or the
[Rails quickstart](../docs/guides/quickstart-rails.md) — the Rails guide walks
`bin/rails generate openreceive:install`, whose output is exercised by the
engine gem's generator tests and by the Rails demo here.

## Running a demo

Every Hello Fruit variant runs from the repository root:

```sh
cp -n .env.example .env      # set a receive-only NWC_URI
npm run demo node            # Express + React/Vue/Svelte/Angular  :3000
npm run demo static          # Static HTML + small API             :3001
npm run demo nextjs          # Next.js fullstack                   :3002
npm run demo rails           # Rails + Postgres                    :3003
```

`npm run demo` builds the image and runs the production server inside it. The
`compose.override.yml.example` each variant ships publishes the port and does
nothing else. For an edit-reload loop, run the variant's own `npm run dev`
(or `bin/dev` for Rails) outside Docker.

## The boundary these examples exist to show

- **The host owns orders, prices, and fulfillment.** Every variant creates its
  own order row first, then hands OpenReceive an order id. None of them lets the
  browser name an amount.
- **The receive-only NWC code never leaves the server.** It is read from the
  repository-root `.env` by server code only; no variant ships it to a bundle.
- **Demos import the shared `@openreceive/*` UI — they never fork it.** When a
  demo needs different markup, it composes the packaged components and class
  registries rather than copying them. The one hand-written port (the Rails
  method wizard) is guarded by a drift check; see
  [`hello-fruit/README.md`](hello-fruit/README.md).
- **Product data has one source.** `hello-fruit/shared/fruits.json` is the
  catalog for all four variants; nothing re-declares fruit ids, prices, or
  sticker paths.
