# Secret Management

NWC connection strings are wallet secrets. Receive-only credentials are safer
than read/write credentials, but they can still create invoices and expose
wallet metadata.

## Repository Rules

- Commit `.env.example`, not real `.env` files.
- Do not commit `OPENRECEIVE_NWC` values.
- Do not put NWC secrets in browser code, mobile apps, fixtures, screenshots,
  source maps, docs, logs, or error payloads.
- Keep `private/` for local-only launcher scripts and notes.

`npm run scan:secrets` rejects likely NWC strings and tracked non-example env
files. `npm run scan:client-bundles` scans generated demo bundles after
`npm run build:demo` so browser artifacts do not contain `OPENRECEIVE_NWC` or
NWC connection URIs.

## Local Development

Use a local env file ignored by git:

```sh
OPENRECEIVE_NWC=nostr+walletconnect://...
OPENRECEIVE_WALLET_PROFILE=rizful
```

Run live tests only with low-value receive-only credentials:

```sh
npm run test:live:nwc
```

The script skips when `OPENRECEIVE_NWC` is unset and redacts the connection
string when it is present.

## Deployment

Inject wallet secrets at runtime from the host, platform secret store, or
operator-managed secret files. Do not bake secrets into build artifacts or demo
images.

Production integrations should use separate credentials from demos and staging.
Rotate credentials after accidental exposure, after staff changes, and before
moving from public demos to production payment flows.

## Logging

Logs may include invoice ids, payment hashes, amounts, workflow states, and
non-secret capability summaries. Logs must not include raw NWC URIs, client
secrets, signed event URLs, or bearer tokens.
