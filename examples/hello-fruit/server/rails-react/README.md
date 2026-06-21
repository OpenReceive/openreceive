# Hello Fruit Rails React

This Rails React demo is quarantined until the active Rails proof is fully
green. It stays in the repo only as a parking place for the future React-on-Rails
proof and must not be treated as an active demo.

It still boots through `openreceive-rails`, uses the package-owned
ActiveRecord invoice store, and requires a valid `OPENRECEIVE_NWC` before
runtime.

The browser never receives `OPENRECEIVE_NWC`.

Use the active Rails demo for supported Rails behavior.

Run locally with Docker:

```sh
docker compose -f compose.yml -f compose.override.yml.example up --build
```

The quarantined skeleton exposes `/healthz` and `/demo-metadata.json` for smoke
checks. Runtime wallet configuration is read from the environment or the
optional root `.env` file mounted by compose, and the skeleton refuses to boot
when it is missing or malformed.
