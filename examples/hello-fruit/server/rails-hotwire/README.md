# Hello Fruit Rails Hotwire

This is the Rails Hotwire Hello Fruit demo skeleton. It uses
`openreceive-rails` inside a normal Rails app, with Rails controllers and Turbo
updates owning the application workflow.

The browser never receives `OPENRECEIVE_NWC`.
OpenReceive invoice persistence uses SQLite storage selected by
`OPENRECEIVE_STORE`. The fruit unlock table remains app-owned demo business
state. The demo can recover paid invoices after a restart or closed browser
window when the browser or app asks the status route for fresh state.

Run locally with Docker:

```sh
docker compose -f compose.yml -f compose.override.yml.example up --build
```

Set a valid receive-only `OPENRECEIVE_NWC` in the repository root `.env` or the
process environment before starting the container. The demo validates it before
booting, runs `rails db:prepare`, stores app SQLite data under a named Docker
volume, and stores OpenReceive invoice data under a separate `.openreceive`
volume.

The demo exposes `/demo-metadata.json` for smoke checks. Runtime wallet
configuration is read from the environment or the optional root `.env` file
mounted by compose.
