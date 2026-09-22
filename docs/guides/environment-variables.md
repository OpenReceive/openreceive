# Environment variables

OpenReceive reads only a few environment variables, and they are mostly
secrets: one wallet connection, an optional pair of swap providers, and a few
non-secret operational toggles. Currencies, route prefixes, callbacks, and other
ordinary app settings do **not** belong here. Put those in your framework's
normal tracked configuration, such as a Node configuration module or a Rails
initializer.

The libraries read `process.env` or `ENV`. They do not find or load a `.env`
file themselves. Your app's entry point may load one for local development. In
production, supply the same variables through your secret manager or process
environment. Start from the `.env.example` file at the repository root.

## Required

| Variable | Meaning |
| --- | --- |
| `NWC_URI` | The **receive-only** Nostr Wallet Connect connection. OpenReceive builds its wallet client from it. Boot fails closed (refuses to start) when it is missing, cannot be parsed, or advertises spend methods. Never expose any part of it to browser code. |

```dotenv
NWC_URI=nostr+walletconnect://WALLET_SERVICE_PUBLIC_KEY?relay=wss%3A%2F%2Frelay.example&secret=CLIENT_SECRET
```

If you pass the connection in code instead (`createOpenReceive({ nwc })`, Rails
`config.nwc`), the variable is not read at all.

## Swap providers (optional)

| Variable | Meaning |
| --- | --- |
| `LSC_URI_PRIMARY` | Primary [Lightning Swap Connect](lightning-swap-connect.md) provider. If you omit it, checkout is Lightning-only. |
| `LSC_URI_BACKUP` | Backup provider. OpenReceive uses it **only** when the primary is down (a network or API failure). |

```dotenv
LSC_URI_PRIMARY=lightning+swapconnect://primary.example/?key=...&secret=...
LSC_URI_BACKUP=
```

While the primary answers, OpenReceive uses only the primary for catalogs,
quotes, and creates. If a healthy primary simply does not offer an asset,
OpenReceive does **not** fall back to the backup for that asset. An empty
connection value is ignored.

## Optional toggles (non-secret)

| Variable | Default | Meaning |
| --- | --- | --- |
| `LOG_LEVEL` | `INFO` | Console and file verbosity: `DEBUG` \| `INFO` \| `WARN` \| `ERROR`. Case-insensitive. |
| `OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC` | unset (off) | Boot even when the wallet advertises spend methods such as `pay_invoice`. Accepts `1` / `true` / `yes`. Any other value logs a warning and counts as off. **A leaked spend-capable code can drain the wallet.** Set this only when the wallet cannot create a receive-only code and you accept that risk. Same as `allowSpendCapableWallet` / `config.allow_spend_capable_wallet`. |
| `OPENRECEIVE_PRICE_FEED_PRIMARY_URL` | built-in feed | Replaces the BTC/fiat price feed. It must serve Simple Price JSON. For development and testing. |
| `OPENRECEIVE_PRICE_FEED_FALLBACK_URL` | built-in feed | Fallback price feed, in the same format. |
| `OPENRECEIVE_NOTIFICATIONS_RECONCILE_INTERVAL_SECONDS` | `15` | Seconds between the periodic reconcile passes of the Rails `openreceive:notifications` worker. |

## Not an environment variable

`OPENRECEIVE_ATTEMPT_EXPIRY_GRACE_SECONDS` looks like an environment variable,
but it is not. It is an **exported constant** (900 seconds) in
`@openreceive/http`. It is part of the rule for closing attempts, not
deployment configuration. Setting it in the environment does nothing. See
[Storage](storage.md#attempt-state-machine).

For the URI format and security of swap connections, see
[Lightning Swap Connect](lightning-swap-connect.md).
