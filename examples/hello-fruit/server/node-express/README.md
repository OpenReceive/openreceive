# Hello Fruit — Express

The demo creates host orders at `/orders`, stores each checkout's payment hash on that order,
and marks it paid once from `onPaid`. OpenReceive is mounted at `/openreceive` with no storage
configuration or migration. React/Vue/Svelte/Angular presentations share the same host flow.

The browser never receives your NWC code. Copy `openreceive.yml.example` to the repository-root
`openreceive.yml`, set a valid receive-only `nwc`, then run:

```sh
docker compose -f compose.yml -f compose.override.yml.example up --build
```
