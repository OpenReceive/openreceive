# Hello Fruit — static HTML

The static client posts its cart to the host `/orders` route, then mounts the checkout element
with that order ID. The server resolves the host-owned price and commits `payment_hash` before
returning the invoice. OpenReceive owns no database.

The browser never receives your NWC code. Copy `openreceive.yml.example` to the repository-root
`openreceive.yml`, set a valid receive-only `nwc`, then run:

```sh
docker compose -f compose.yml -f compose.override.yml.example up --build
```
