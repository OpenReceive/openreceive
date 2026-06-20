# Hello Fruit: Express + React

This v0.1 demo mounts OpenReceive routes inside an Express app and renders a
React checkout for the shared Hello Fruit sticker product.

The browser never receives `OPENRECEIVE_NWC`.

## Run

```sh
cp .env.example .env
# Set OPENRECEIVE_NWC to a receive-capable NWC connection string.
npm install
npm run dev
```

Open the Vite URL and create a tiny fruit-sticker invoice.

For a production-style local run, build the client and start the Express server:

```sh
npm run build
npm start
```

To run the container template locally:

```sh
cp .env.example .env
docker compose up --build
```

The Makefile exposes the standard demo commands: `make setup`, `make dev`,
`make test`, `make demo-test-nwc`, `make demo-production`,
`make docker-build`, `make docker-run`, and `make docker-smoke`.

The server also exposes `/demo-metadata.json` with non-secret package, mode,
git SHA, image digest, and `deployed_at` metadata for hosted-demo smoke checks.

Hosted-demo helpers expose `/healthz`, `/source`, `/docs`, `/robots.txt`, and
`/sitemap.xml`.

This demo uses `unsafeAllowUnauthenticatedDemoMode` because it is a local
single-user example. Production apps should use app auth and CSRF hooks.
