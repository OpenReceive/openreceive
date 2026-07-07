# Demo Deployment Templates

This directory contains public, non-secret deployment templates for OpenReceive
hosted demos. It is not an inventory of any private host.

Stable demos run on a separate demo edge, not on the private apex app
infrastructure. Keep private hostnames, IP addresses, SSH keys, WireGuard
configuration, Cloudflare tokens, GHCR tokens, and receive-only NWC codes outside
this repository.

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

Keep runtime env files on the host, for example:

```text
/opt/openreceive/secrets/rizful-test-wallet.env
/opt/openreceive/secrets/production-wallet.env
/opt/openreceive/secrets/cloudflare-dns.env
/opt/openreceive/secrets/ghcr.env
```

Those files must be mode `600` and must not be committed. Demo stack compose
files load private values through `env_file`; demo images never bake them in.
The receive-only NWC code env file must provide server-only `OPENRECEIVE_NWC`,
`OPENRECEIVE_STORE`, and `OPENRECEIVE_NAMESPACE`. Optional automated swaps use
server-only `OPENRECEIVE_SWAP_CONFIG` plus the provider secret env vars
referenced by that YAML file in the same private env boundary. Each demo has one
web service whose app routes call the
OpenReceive service and use durable OpenReceive invoice storage. Status refresh
happens only inside app requests. No demo deploys an extra timed process or
wallet event listener.

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
