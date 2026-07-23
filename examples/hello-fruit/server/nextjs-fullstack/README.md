# Hello Fruit — Next.js

The App Router owns `/orders` and durable order semantics; the catch-all `/openreceive` route
only performs wallet/provider communication. The demo stores payment correlation in its host
order repository, uses stateless capability tokens, and has no OpenReceive storage or migration.

The browser never receives your NWC code. Copy `openreceive.yml.example` to the repository-root
`openreceive.yml`, set a valid receive-only `nwc`, then run:

```sh
docker compose -f compose.yml -f compose.override.yml.example up --build
```
