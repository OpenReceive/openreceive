# Hello Fruit Next.js Fullstack Demo

This demo runs the Hello Fruit checkout in a Next.js App Router application.
The browser never receives `OPENRECEIVE_NWC`. App Router catch-all handlers mount
OpenReceive via `openReceiveNextHandlers` with a required `getCheckoutAmount`;
`/prepare_order` persists the host order first. The client uses
`<Checkout orderId />` and never posts a price.

## Local Setup

```sh
npm install
npm run dev
```

Set a valid receive-only `OPENRECEIVE_NWC` in the repository root
`openreceive.yml` before starting the dev server.

## Container

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

The production container exposes only port `3002` to the Docker network unless
the local override is used.

## Metadata

`/demo-metadata.json` exposes non-secret build metadata for hosted-demo smoke
checks. It never includes wallet connection strings or NWC query secrets.

Production apps that require signed-in or session-bound checkout should use
their normal app middleware for private checkout routes.
