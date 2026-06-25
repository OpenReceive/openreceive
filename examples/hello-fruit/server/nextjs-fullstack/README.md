# Hello Fruit Next.js Fullstack Demo

This demo runs the Hello Fruit checkout in a Next.js App Router application.
The browser never receives `OPENRECEIVE_NWC`. Next.js route handlers create and
check invoices through server-side OpenReceive helpers.

## Local Setup

```sh
npm install
npm run dev
```

Set a valid receive-only `OPENRECEIVE_NWC` in the process environment before
starting the dev server.

## Container

```sh
cp ../../../../.env.example ../../../../.env
# Set OPENRECEIVE_NWC in the repository root .env file.
docker compose -f compose.yml -f compose.override.yml.example up --build
```

Docker loads the repository root `.env` file, so the same
`OPENRECEIVE_NWC` value can be shared across all local Hello Fruit demos
without demo-local env files. Set it before running Compose; the web container
validates it at startup. The compose stack uses `local-sqlite` by default and
stores OpenReceive state in a named `.openreceive` volume.

The package exposes `npm run openreceive:poll` for optional scheduled recovery.
Normal checkout recovery happens through backend payment-status checks.

The production container exposes only port `3002` to the Docker network unless
the local override is used.

## Metadata

`/demo-metadata.json` exposes non-secret build metadata for hosted-demo smoke
checks. It never includes wallet connection strings or NWC query secrets.

Production apps that require signed-in or session-bound checkout should use
their normal app middleware for private checkout routes;
see [Optional Scheduler](../../../../docs/guides/optional-scheduler.md).
