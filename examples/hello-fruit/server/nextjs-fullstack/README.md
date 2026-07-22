# Hello Fruit Next.js Fullstack Demo

This demo runs the Hello Fruit checkout in a Next.js App Router application.
The browser never receives your NWC code. App Router catch-all handlers mount
OpenReceive via `openReceiveNextHandlers` with required `prepareCheckout`. POST
`/openreceive/prepare` is the sole price authority. The client uses
`<Checkout orderId />` and never posts a price on create.

Settlement fulfillment is server-side: `onPaid` marks the order summary
`paid`, and sticker downloads go through gated `GET /delivery/:orderId/:productId`
(capability token required). Browser `onSettled` only refreshes UI after that
server state is visible.

## Local Setup

```sh
npm install
npm run dev
```

Set a valid receive-only `nwc` in the repository root
`openreceive.yml` before starting the dev server.

## Container

```sh
cp ../../../../openreceive.yml.example ../../../../openreceive.yml
# Set `nwc` in the repository root openreceive.yml file.
docker compose -f compose.yml -f compose.override.yml.example up --build
```

Docker mounts the repository root `openreceive.yml` file, so the same
`nwc` value can be shared across all local Hello Fruit demos
without demo-local config files. Set it before running Compose; the web container
validates it at startup. The compose stack omits `store`, so Node
falls back to `local-sqlite` (or adopts Postgres `DATABASE_URL` when set) and
stores OpenReceive state in a named `.openreceive` volume for the SQLite path.

Normal checkout recovery happens through backend payment-status checks. No
extra OpenReceive command is required.

The production container exposes only port `3002` to the Docker network unless
the local override is used.

This demo mounts with `guestCheckout()` (anonymous create; reads gated by the
per-order capability token). For a signed-in app, swap `authorize` for
`withUser(...)` — see the comment in `src/server/openreceive.ts`.

Guest checkout resume: after POST `/openreceive/prepare`, the app navigates to
`/checkout/:orderId`. Refresh keeps the same payment UI while the OpenReceive
capability cookie remains valid. `<Checkout orderId />` restores the host display
from `GET /openreceive/orders/:orderId/summary`. Never put the capability token
in the URL.
