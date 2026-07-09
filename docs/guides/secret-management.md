# NWC Code Management

Receive-only NWC codes can create invoices and expose wallet metadata. Treat
them as private server-only configuration.

## Repository Rules

- Commit `openreceive.yml.example`, not real `openreceive.yml` files.
- Do not commit `OPENRECEIVE_NWC` values.
- Do not commit swap provider credentials.
- Do not put receive-only NWC codes in browser code, mobile apps, fixtures,
  screenshots, source maps, docs, logs, or error payloads.
- Keep local-only launcher scripts and notes outside the repo (or gitignored).

`npm run scan:secrets` rejects likely NWC strings and tracked local config
files. `npm run scan:client-bundles` scans generated demo bundles after
`npm run build:demo` so browser artifacts do not contain `OPENRECEIVE_NWC` or
NWC connection URIs.

## Local Development

Use the local YAML file ignored by git:

```yaml
OPENRECEIVE_NWC: nostr+walletconnect://...
OPENRECEIVE_NAMESPACE: default
OPENRECEIVE_STORE: local-sqlite

swap:
  providers:
    - id: fixedfloat
      protocol: fixedfloat
      base_url: https://ff.io
      key: ...
      secret: ...
```

Run live tests only with a low-value receive-only NWC code:

```sh
npm run test:live:nwc
```

The script reads `OPENRECEIVE_NWC` from `openreceive.yml` and skips when unset.
When a wallet is configured, it redacts the code, creates a low-value test
invoice, and verifies payment server-side before fulfillment.

## Deployment

Mount or inject `openreceive.yml` at runtime from the host, platform secret
store, or operator-managed secret file. Do not bake it into build artifacts or
demo images.

Hosted demos may expose public build metadata such as package versions, git
SHA, image digest, demo mode, and `deployed_at`. Treat those as allowlisted
fields, not a generic environment dump. The Hello Fruit demos filter git SHAs,
image digests, and deployment timestamps to public-safe shapes before returning
`/demo-metadata.json`.

Production integrations should use separate credentials from demos and staging.
Rotate credentials after accidental exposure, after staff changes, and before
moving from public demos to production payment flows.

## Logging

Logs may include invoice ids, payment hashes, amounts, and payment status. Logs
must not include raw NWC URIs, client secrets, signed status/refresh URLs, or
bearer tokens.
