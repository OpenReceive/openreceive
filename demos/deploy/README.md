# Demo Deployment Templates

This directory contains public, non-secret deployment templates for OpenReceive
hosted demos. It is not an inventory of any private host.

Stable demos run on a separate demo edge, not on the private apex app
infrastructure. Keep private hostnames, IP addresses, SSH keys, WireGuard
configuration, Cloudflare tokens, GHCR tokens, and NWC credentials outside this
repository.

## Layout

- `inventory/*.env.example` documents non-secret deployment variables.
- `inventory/hosts.yml` records public demo slugs and placeholders for private
  operator-owned host data.
- `proxy/compose.yml` runs Caddy on the shared `openreceive_demo_proxy`
  network.
- `proxy/sites/*.caddy` routes stable demo hostnames to Docker service names.
- `stacks/*.compose.yml` defines one demo service per compose project.
- `manifests/*.json` records public deployment metadata shape.
- `scripts/` contains small operator helpers that print variable names and avoid
  passing secrets on command lines.

## Operator Flow

Create the shared proxy network once on the demo node:

```sh
docker network create openreceive_demo_proxy
```

Keep runtime secrets on the host, for example:

```text
/opt/openreceive/secrets/rizful-test-wallet.env
/opt/openreceive/secrets/production-wallet.env
/opt/openreceive/secrets/cloudflare-dns.env
/opt/openreceive/secrets/ghcr.env
```

Those files must be mode `600` and must not be committed. Demo stack compose
files load secrets through `env_file`; demo images never bake them in. The
demo web service and `openreceive-worker` service load the same server-side env
file so invoices, polling, and notifications share the app's durable database
configuration.

Validate public templates locally:

```sh
npm run check:demo-deploy
```

Run a smoke check against an already-running demo:

```sh
./demos/deploy/scripts/smoke-demo https://express-demo.openreceive.org
```

The public demo set currently reserves:

- `express-demo.openreceive.org`
- `static-demo.openreceive.org`
- `nextjs-demo.openreceive.org`
