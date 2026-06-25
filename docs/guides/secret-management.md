# NWC Code Management

Receive-only NWC codes can create invoices and expose wallet metadata. Treat
them as private server-only configuration.

## Repository Rules

- Commit `.env.example`, not real `.env` files.
- Do not commit `OPENRECEIVE_NWC` values.
- Do not put receive-only NWC codes in browser code, mobile apps, fixtures,
  screenshots, source maps, docs, logs, or error payloads.
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

To read those values from an ignored local file instead of exported shell
variables, set:

```sh
OPENRECEIVE_ENV_FILE=private/rizful-test-wallet.env
```

Run live tests only with a low-value receive-only NWC code:

```sh
npm run test:live:nwc
```

The script skips when `OPENRECEIVE_NWC` is unset. It only reads an env file when
`OPENRECEIVE_ENV_FILE` is set, so normal test runs do not accidentally use a
developer's local receive-only NWC code. When a wallet is configured, it redacts
the code, creates a low-value test invoice, and verifies payment server-side
before fulfillment.

## Deployment

Inject receive-only NWC codes at runtime from the host, platform secret store, or
operator-managed env files. Do not bake them into build artifacts or demo
images.

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
must not include raw NWC URIs, client secrets, signed lookup/refresh URLs, or
bearer tokens.
