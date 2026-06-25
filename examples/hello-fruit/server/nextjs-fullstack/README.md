# Hello Fruit Next.js Fullstack Demo

This demo runs the Hello Fruit checkout in a Next.js App Router application.
The browser never receives `OPENRECEIVE_NWC`. Next.js route handlers create and
look up invoices through server-side OpenReceive helpers.

## Local Setup

```sh
npm install
npm run dev
```

Set a valid receive-only `OPENRECEIVE_NWC` in the process environment before
starting the dev server. The demo refuses to boot when it is missing or
malformed.

## Container

```sh
cp ../../../../.env.example ../../../../.env
# Set OPENRECEIVE_NWC in the repository root .env file.
docker compose -f compose.yml -f compose.override.yml.example up --build
```

Docker loads the repository root `.env` file, so the same
`OPENRECEIVE_NWC` value can be shared across all local Hello Fruit demos
without demo-local env files. Set it before running Compose; the web container
validates it at startup. The compose stack also starts a local
Postgres container and points `OPENRECEIVE_STORE` at it; the demo uses the
package-owned OpenReceive Postgres KV store and self-initializes the
OpenReceive schema before store queries.

The package exposes `npm run openreceive:poll` for an optional one-shot
scheduled reconciliation pass. Normal checkout recovery happens through
backend lookup routes.

The production container exposes only port `3002` to the Docker network unless
the local override is used.

## Metadata

`/demo-metadata.json` exposes non-secret build metadata for hosted-demo smoke
checks. It never includes wallet connection strings or NWC query secrets.

Production apps that require signed-in or session-bound checkout should mount
OpenReceive routes behind their normal app middleware;
see [Deployment And Recovery](../../../../docs/guides/deployment-and-recovery.md).
