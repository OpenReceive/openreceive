# OpenReceive examples

Two apps live here, and they answer different questions.

| Directory | What it is | Start with it when |
| --- | --- | --- |
| [`hello-fruit/`](hello-fruit) | The full fruit-sticker shop, built four times over four server stacks | You want to see a complete checkout: catalog, cart, currency picker, Lightning + swap rails, resume-after-refresh, post-pay delivery |
| [`hello-fruit-rails/`](hello-fruit-rails) | A deliberately tiny Rails host | You want to check `bin/rails generate openreceive:install` against a real app, or read the smallest possible integration |

The quickstart is Lightning-only and creates one $2.00 order from a Stimulus
controller. It is not a smaller Hello Fruit — it shares no code with it.

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

The quickstart has no compose stack; see its
[README](hello-fruit-rails/README.md).

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
