# Hello Fruit — Express

The demo creates host orders at `/orders` and stores checkout attempts in a
separate in-memory payment repository. One order can retain multiple attempts;
`onPaid` marks the exact hash paid and fulfills once. OpenReceive is mounted at
`/openreceive` with no runtime storage configuration.

The browser UI is frontend-only, but this Express process is a real server: it
holds the receive credential and server-only `swap_data`. Its maps are
deliberately disposable and safe only for one local process. Restarting loses
orders and attempts, and multiple instances would not share the order lock. Use
the host application's existing database and an ORM recipe for a real
deployment.

The browser never receives your NWC code. Copy the repository-root `.env.example`
to `.env`, set a valid receive-only `NWC_URI`, then run:

```sh
docker compose -f compose.yml -f compose.override.yml.example up --build
```
