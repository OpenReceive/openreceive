# Hello Fruit: Static HTML + Small API

This v0.1 demo keeps the checkout page static and mounts OpenReceive's shipped
routes for the shared Hello Fruit sticker product. `/prepare_order` persists the
authoritative order; `getCheckoutAmount` prices checkout create; the static client
renders `<openreceive-checkout order-id>` (no client price on the wire).

The browser never receives `OPENRECEIVE_NWC`.

## Run

```sh
npm install
npm run dev
```

Open the Vite URL and create a tiny fruit-sticker invoice.
Set a valid receive-only `OPENRECEIVE_NWC` in the repository root
`openreceive.yml` before starting the dev server.

For a production-style local run, build the client and start the Express server:

```sh
npm run build
npm start
```

To run the container template locally:

```sh
cp ../../../../openreceive.yml.example ../../../../openreceive.yml
# Set OPENRECEIVE_NWC in the repository root openreceive.yml file.
docker compose -f compose.yml -f compose.override.yml.example up --build
```

Docker mounts the repository root `openreceive.yml` file, so the same
`OPENRECEIVE_NWC` value can be shared across all local Hello Fruit demos
without demo-local config files. Set it before running Compose; the web container
validates it at startup. The compose stack uses `local-sqlite` by default and
stores OpenReceive state in a named `.openreceive` volume.

Normal checkout recovery happens through backend payment-status checks. No
extra OpenReceive command is required.

The Makefile exposes the standard demo commands: `make setup`, `make dev`,
`make test`, `make demo-test-nwc`, `make demo-production`,
`make docker-build`, `make docker-run`, and `make docker-smoke`.

The server also exposes `/demo-metadata.json` with non-secret package, mode,
git SHA, image digest, and `deployed_at` metadata for hosted-demo smoke checks.

Hosted-demo helpers expose `/source`, `/docs`, `/robots.txt`, and
`/sitemap.xml`.

This demo mounts with `guestCheckout()` (anonymous create; reads gated by the
per-order capability token). For a signed-in app, swap `authorize` for
`withUser(...)` — see the comment in `src/server/create-server.ts`.
