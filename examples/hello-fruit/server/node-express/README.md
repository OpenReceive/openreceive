# Hello Fruit — Express

The demo creates host orders at `/orders` and stores checkout attempts in a
host-owned local SQLite database (Node's built-in `node:sqlite`). One order can
retain multiple attempts; `onPaid` marks the exact hash paid and fulfills once.
OpenReceive is mounted at `/openreceive` with no runtime storage configuration.

Each boot wipes `examples/hello-fruit/.openreceive/<demo>.sqlite` and recreates
the `orders` + `openreceive_payments` tables so the surface stays disposable
while showing the same host persistence shape as
`npx openreceive scaffold payments --orm knex --dialect sqlite`. Use the host
application's existing database and an ORM recipe for a real deployment.

The browser never receives your NWC code. Copy the repository-root `.env.example`
to `.env`, set a valid receive-only `NWC_URI`, then run:

```sh
docker compose -f compose.yml -f compose.override.yml.example up --build
```
