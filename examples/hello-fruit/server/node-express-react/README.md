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

This demo uses `unsafeAllowUnauthenticatedDemoMode` because it is a local
single-user example. Production apps should use app auth and CSRF hooks.
