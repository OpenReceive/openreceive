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
docker compose -f compose.yml -f compose.override.yml.example --profile openreceive-worker up --build
```

Docker loads the repository root `.env` file, so the same
`OPENRECEIVE_NWC` value can be shared across all local Hello Fruit demos
without demo-local env files. Set it before running Compose; the web and worker
containers validate it at startup. The compose stack also starts a local
Postgres container and points `DATABASE_URL` at it; the demo uses the
package-owned OpenReceive Postgres invoice store, runs the package migration,
and records the OpenReceive schema version before store queries.

The package exposes `npm run openreceive:worker`, which loads the default
`openreceive.config.mjs` and runs polling plus notification listening in one
backend process. `npm run openreceive:poll:once` is available for scheduled
serverless polling.

The production container exposes only port `3002` to the Docker network unless
the local override is used.

## Metadata

`/demo-metadata.json` exposes non-secret build metadata for hosted-demo smoke
checks. It never includes wallet connection strings or NWC query secrets.

Production Node apps deploy a web process plus one OpenReceive worker;
see [Background Process Deployment](../../../../docs/17-background-workers.md).
