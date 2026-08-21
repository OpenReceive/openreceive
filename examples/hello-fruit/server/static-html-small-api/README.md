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

## Deliberate simplifications

This variant is the floor, not a feature-complete shop. It builds its DOM by
hand instead of using a framework, and it leaves per-IP invoice rate limiting
**off** — see the Express variant and the rate-limiting guide for the setting a
public web shop wants. Everything payer-visible still matches the other
variants, including the confetti burst and the full multi-sticker download
list for a cart with more than one line.

The browser never receives your NWC code. Copy the repository-root `.env.example`
to `.env`, set a valid receive-only `NWC_URI`, then run:

```sh
docker compose -f compose.yml -f compose.override.yml.example up --build
```
