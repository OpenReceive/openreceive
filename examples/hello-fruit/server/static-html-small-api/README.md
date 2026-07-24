# Hello Fruit — static HTML

The static client posts its cart to the host `/orders` route, then mounts the checkout element
with that order ID. The server resolves the host-owned price and commits an
attempt row before returning the invoice. Orders and payment attempts remain
separate.

Both live in a host-owned local SQLite database wiped and recreated on every
demo boot (`examples/hello-fruit/.openreceive/`). The static UI is frontend-only;
the API process is still trusted server code because it holds the receive
credential and `swap_data`. Use the host application's existing database for a
real deployment — see `npx openreceive scaffold payments --dialect sqlite`.

The browser never receives your NWC code. Copy the repository-root `.env.example`
to `.env`, set a valid receive-only `NWC_URI`, then run:

```sh
docker compose -f compose.yml -f compose.override.yml.example up --build
```
