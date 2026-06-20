# Hello Fruit Next.js Fullstack Demo

This demo runs the Hello Fruit checkout in a Next.js App Router application.
The browser never receives `OPENRECEIVE_NWC`. Next.js route handlers create and
look up invoices through server-side OpenReceive helpers.

## Local Setup

```sh
npm install
cp .env.example .env
npm run dev
```

Leave `OPENRECEIVE_NWC` empty to inspect the UI and fail-closed API behavior.
Set it only in a gitignored local env file or host secret before creating live
invoices.

## Container

```sh
docker compose -f compose.yml -f compose.override.yml.example up --build
```

The production container exposes only port `3002` to the Docker network unless
the local override is used.

## Metadata

`/demo-metadata.json` exposes non-secret build metadata for hosted-demo smoke
checks. It never includes wallet connection strings or NWC query secrets.
