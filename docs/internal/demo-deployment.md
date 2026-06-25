# Demo Deployment

Hosted demos are public examples, not part of the private `openreceive.org`
application. Keep the demo fleet on a separate demo edge or node with its own
DNS records, proxy, compose projects, secrets, and release path.

## Public Boundary

Stable demos use explicit subdomains:

- `https://express-demo.openreceive.org/`
- `https://static-demo.openreceive.org/`
- `https://nextjs-demo.openreceive.org/`

Do not route stable demos through the private apex app, private Kamal deploy, or
private app reverse proxy. The private app may link to demos, but it is not in
their deployment path. Private hostnames, IP addresses, WireGuard details,
capacity notes, and operator inventory stay outside this repository.

The public deployment templates live in `demos/deploy/`:

- `inventory/hosts.yml` records public demo slugs, hostnames, images, and health
  URLs.
- `proxy/compose.yml` runs the shared Caddy proxy on the
  `openreceive_demo_proxy` Docker network.
- `proxy/sites/*.caddy` maps stable demo hostnames to Docker service names.
- `stacks/*.compose.yml` runs one demo service per compose project.
- `manifests/*.json` records public deployment metadata shape.
- `scripts/` contains operator helpers that print variable names, never secret
  values.

Validate those templates with:

```sh
npm run check:demo-deploy
```

## Proxy And DNS

Caddy is the only public container in the stable demo fleet. It may publish
ports `80` and `443` on the separate demo node. Demo containers should use
`expose`, not host `ports`, and Caddy should route to Docker service names:

```text
express-demo.openreceive.org -> express-demo:3000
static-demo.openreceive.org  -> static-demo:3001
nextjs-demo.openreceive.org  -> nextjs-demo:3002
```

Create the proxy network once on the demo node:

```sh
docker network create openreceive_demo_proxy
```

Use explicit Cloudflare DNS records for stable demo hostnames. Do not create a
broad `*.openreceive.org` wildcard for the demo fleet, and do not point stable
demo records at the private production edge.

Cloudflare should stay in front of public demo subdomains. For origin TLS, use
Caddy with the Cloudflare DNS module and ACME DNS-01. Store the Cloudflare DNS
API token only on the demo host, scoped narrowly enough for certificate
challenges. Cloudflare Origin CA certificates are acceptable for proxied-only
demo origins, but DNS-01 is the default renewal path.

Bypass caching for invoice, lookup, refresh, and poll paths such as
`/openreceive/*` and `/api/*`. Demo handlers should return `no-store` for
checkout state, lookup, refresh, and poll responses.

## Private Runtime Files

Demo images must not bake in receive-only NWC codes. Runtime private values belong
in host-managed files such as:

```text
/opt/openreceive/secrets/rizful-test-wallet.env
/opt/openreceive/secrets/production-wallet.env
/opt/openreceive/secrets/cloudflare-dns.env
/opt/openreceive/secrets/ghcr.env
```

Those files should be mode `600` and owned by the deploy user or root. Compose
templates load them through `env_file`; the examples mark the files optional so
local config validation can run without real secrets.

Never commit:

- `OPENRECEIVE_NWC`
- Cloudflare API tokens
- GHCR tokens
- deploy SSH keys
- WireGuard configuration
- private deployment inventory

`npm run scan:secrets` rejects tracked env-like files and real-looking NWC
strings. `npm run check:demo-deploy` also checks the public deploy templates for
secret-bearing values.

## Deployment Flow

GitHub-hosted CI should build, test, and publish immutable demo images. The
demo node should pull already-built images by tag or digest and restart
containers. Do not compile packages interactively on the demo node.

Manual promotion is the first v0.1 deployment path:

```sh
./demos/deploy/scripts/deploy-demo express-demo
./demos/deploy/scripts/smoke-demo https://express-demo.openreceive.org
```

`deploy-demo` is a public-safe template. A private operator wrapper can add SSH,
image pull, compose update, Caddy reload, and rollback behavior without putting
private host details in this repo.

Each deploy should:

- update one demo at a time
- pull a tested GHCR image
- keep a per-demo deploy lock
- validate compose and Caddy config before reload
- write public deployment metadata
- smoke `/healthz` and `/demo-metadata.json`
- roll back to the previous image digest on failure

Stable demo pages should expose non-secret build metadata such as git SHA,
image digest, demo mode, package versions, and `deployed_at`. They must not
expose environment dumps or wallet configuration.

## CI And Runner Isolation

Keep build/test runners separate from deploy runners.

GitHub-hosted runners may:

- run `npm run test:ci`
- build demo images
- push GHCR images with package permissions

GitHub-hosted runners should not need:

- `OPENRECEIVE_NWC`
- office network access
- WireGuard private keys
- deploy SSH keys unless a protected SSH deploy path is explicitly approved

If a self-hosted runner is used for deployment, restrict it to protected
branches, tags, `workflow_dispatch`, or a protected GitHub environment. Do not
run untrusted pull requests on a runner that can reach deploy credentials,
WireGuard keys, Docker on the demo host, or receive-only NWC code files.

Never mount the host Docker socket into a broad or untrusted CI runner. Docker
socket access is effectively host-root access.

## Preview And Staging

Preview deployments are optional and must be visibly separate from stable
public demos. Use noindex headers and robots disallow for previews. If preview
DNS is needed, scope it under a dedicated namespace such as
`preview.openreceive.org`.

Staging demo hostnames may use `*.staging.openreceive.org`. Staging still uses
receive-only NWC codes and the same handling rules as production demos.
