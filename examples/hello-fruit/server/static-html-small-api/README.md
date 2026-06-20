# Hello Fruit: Static HTML + Small API

This v0.1 demo keeps the checkout page static and mounts OpenReceive routes
inside a small Express API for the shared Hello Fruit sticker product.

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

The server also exposes `/demo-metadata.json` with non-secret package, mode,
git SHA, and image digest metadata for hosted-demo smoke checks.

This demo uses `unsafeAllowUnauthenticatedDemoMode` because it is a local
single-user example. Production apps should use app auth and CSRF hooks.
