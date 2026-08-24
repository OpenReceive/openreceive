# Environment variables

OpenReceive reads a small, secret-only environment: one wallet connection, an
optional swap-provider pair, and a handful of non-secret operational toggles.
Currencies, route prefixes, callbacks, and other ordinary application settings
do **not** belong here — put those in your framework's normal tracked
configuration (a Node configuration module, a Rails initializer).

The libraries read `process.env` or `ENV`; they do not find or load a `.env`
file themselves. Application entry points may load one for local development.
Production should supply the same variables through its secret manager or
process environment. The repository-root `.env.example` is the copy-paste
starting point.

## Required

| Variable | Meaning |
| --- | --- |
| `NWC_URI` | The **receive-only** Nostr Wallet Connect connection the wallet client is built from. Boot fails closed when it is missing, unparsable, or advertises spend methods. Never expose any part of it to browser code. |

```dotenv
NWC_URI=nostr+walletconnect://WALLET_SERVICE_PUBLIC_KEY?relay=wss%3A%2F%2Frelay.example&secret=CLIENT_SECRET
```

Pass it explicitly instead (`createOpenReceive({ nwc })`, Rails
`config.nwc`) and the variable is not read at all.

## Swap providers (optional)

| Variable | Meaning |
| --- | --- |
| `LSC_URI_PRIMARY` | Primary [Lightning Swap Connect](lightning-swap-connect.md) provider. Omitted, checkout is Lightning-only. |
| `LSC_URI_BACKUP` | Backup provider, consulted **only** when the primary is down (network/API failure). |

```dotenv
LSC_URI_PRIMARY=lightning+swapconnect://primary.example/?key=...&secret=...
LSC_URI_BACKUP=
```

While the primary answers, OpenReceive uses only the primary for catalogs,
quotes, and creates. A healthy primary that simply omits an asset does **not**
fail over to the backup for that asset. An empty connection is ignored.

## Optional toggles (non-secret)

| Variable | Default | Meaning |
| --- | --- | --- |
| `LOG_LEVEL` | `INFO` | Console/file verbosity: `DEBUG` \| `INFO` \| `WARN` \| `ERROR`, case-insensitive. |
| `OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC` | unset (off) | Boot anyway when the wallet advertises spend methods such as `pay_invoice`. Accepts `1` / `true` / `yes`; any other set value warns and reads as off. **A leaked spend-capable code can drain the wallet** — set this only when the wallet cannot mint a receive-only code and you accept that risk. Equivalent to `allowSpendCapableWallet` / `config.allow_spend_capable_wallet`. |
| `OPENRECEIVE_PRICE_FEED_PRIMARY_URL` | built-in feed | Override the BTC/fiat price feed (must serve Simple Price JSON). Dev/test. |
| `OPENRECEIVE_PRICE_FEED_FALLBACK_URL` | built-in feed | Fallback price feed, same format. |
| `OPENRECEIVE_NOTIFICATIONS_RECONCILE_INTERVAL_SECONDS` | `15` | Seconds between the Rails `openreceive:notifications` worker's periodic reconcile passes. |

## Not an environment variable

`OPENRECEIVE_ATTEMPT_EXPIRY_GRACE_SECONDS` looks like one and is not: it is an
**exported constant** (900 seconds) in `@openreceive/core`, part of the
attempt-closure rule rather than deployment configuration. Setting it in the
environment does nothing. See [Storage](storage.md#attempt-state-machine).

URI grammar and security for swap connections:
[Lightning Swap Connect](lightning-swap-connect.md).
