# Hello Fruit: Express + React/Vue/Svelte/Angular

This v0.1 demo mounts OpenReceive with required `prepareCheckout` (POST
`/openreceive/prepare` is the sole price authority) and renders React, Vue,
Svelte, and Angular checkout tabs for the shared Hello Fruit sticker product.

The browser never receives `OPENRECEIVE_NWC`. Checkout is
`<Checkout orderId />` against `/openreceive` — the client does not post
a price on create.

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

This demo mounts with `guestCheckout()` (anonymous create; reads gated by the
per-order capability token). For a signed-in app, swap `authorize` for
`withUser(...)` — see the comment in `src/server/create-server.ts`.

Guest checkout resume: after POST `/openreceive/prepare`, the app navigates to
`/checkout/:orderId`. Refresh keeps the same payment UI while the OpenReceive
capability cookie remains valid. `<Checkout orderId />` restores the host display
from `GET /openreceive/orders/:orderId/summary`. Never put the capability token
in the URL.
