# Hello Fruit — Next.js

The App Router owns `/orders`; the catch-all `/openreceive` route performs
wallet/provider communication. The demo stores multiple attempts in a
host-owned in-memory payment repository separate from orders and keeps optional
swap provider data server-side. The runtime has no storage configuration.

These process-local maps are deliberately disposable and safe only for one
local server process. Restarting loses orders and attempts, and multiple
instances would not share the order lock. Although part of the application is
rendered in the browser, the route handler is trusted server code because it
holds the receive credential and `swap_data`. Use the host application's
existing database for a real deployment.

The browser never receives your NWC code. Copy the repository-root `.env.example`
to `.env`, set a valid receive-only `NWC_URI`, then run:

```sh
docker compose -f compose.yml -f compose.override.yml.example up --build
```
