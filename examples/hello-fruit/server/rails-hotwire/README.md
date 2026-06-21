# Hello Fruit Rails Hotwire

This is the Rails Hotwire Hello Fruit demo skeleton. It uses
`openreceive-rails` inside a normal Rails app, with Rails controllers, jobs, and
Turbo updates owning the application workflow.

The browser never receives `OPENRECEIVE_NWC`.
OpenReceive invoice persistence uses the package-owned ActiveRecord store and
`openreceive_invoices` migration. The fruit unlock table remains app-owned demo
business state.

Run locally with Docker:

```sh
docker compose -f compose.yml -f compose.override.yml.example up --build
```

The container runs `rails db:prepare` before booting and stores the SQLite
database under a named Docker volume.

The demo exposes `/healthz` and `/demo-metadata.json` for smoke checks. Runtime
wallet configuration is read from the environment or the optional root `.env`
file mounted by compose.
