# Hello Fruit Next.js Fullstack Demo

This demo runs the Hello Fruit checkout in a Next.js App Router application.
The browser never receives `OPENRECEIVE_NWC`. Next.js route handlers create and
look up invoices through server-side OpenReceive helpers.

## Local Setup

```sh
npm install
npm run dev
```

Leave `OPENRECEIVE_NWC` unset to inspect the UI and fail-closed API behavior.
For live invoices without Docker, run the dev server with `OPENRECEIVE_NWC`
already present in the process environment.

## Container

```sh
cp ../../../../.env.example ../../../../.env
# Set OPENRECEIVE_NWC in the repository root .env file.
docker compose -f compose.yml -f compose.override.yml.example up --build
```

Docker loads the repository root `.env` file, so the same
`OPENRECEIVE_NWC` value can be shared across all local Hello Fruit demos
without demo-local env files. The compose stack also starts a local Postgres
container and points `DATABASE_URL` at it; the demo uses the package-owned
OpenReceive Postgres invoice store, runs the package migration, and records the
OpenReceive schema version before store queries.

The production container exposes only port `3002` to the Docker network unless
the local override is used.

## Metadata

`/demo-metadata.json` exposes non-secret build metadata for hosted-demo smoke
checks. It never includes wallet connection strings or NWC query secrets.

Production Node apps should deploy a web process plus one OpenReceive worker;
see [Background Process Deployment](../../../../docs/17-background-workers.md).
