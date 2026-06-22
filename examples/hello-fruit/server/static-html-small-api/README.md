# Hello Fruit: Static HTML + Small API

This v0.1 demo keeps the checkout page static and mounts OpenReceive routes
inside a small Express API for the shared Hello Fruit sticker product.

The browser never receives `OPENRECEIVE_NWC`.

## Run

```sh
npm install
npm run dev
```

Open the Vite URL and create a tiny fruit-sticker invoice.
Set a valid receive-only `OPENRECEIVE_NWC` in the process environment before
starting the dev server. The demo refuses to boot when it is missing or
malformed.

For a production-style local run, build the client and start the Express server:

```sh
npm run build
npm start
```

To run the container template locally:

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
scheduled reconciliation pass through the protected `/openreceive/v1/poll`
route. There is no demo worker or notification listener process.

The Makefile exposes the standard demo commands: `make setup`, `make dev`,
`make test`, `make demo-test-nwc`, `make demo-production`,
`make docker-build`, `make docker-run`, and `make docker-smoke`.

The server also exposes `/demo-metadata.json` with non-secret package, mode,
git SHA, image digest, and `deployed_at` metadata for hosted-demo smoke checks.

Hosted-demo helpers expose `/healthz`, `/source`, `/docs`, `/robots.txt`, and
`/sitemap.xml`.

This demo uses `unsafeAllowUnauthenticatedDemoMode` because it is a local
single-user example. Production apps use app auth, CSRF hooks, and protected
poll authorization;
see [Background Process Deployment](../../../../docs/17-background-workers.md).
