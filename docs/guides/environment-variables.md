# Environment variables

OpenReceive reads a primary LSC connection and an optional backup:

```dotenv
LSC_URI_PRIMARY=lightning+swapconnect://primary.example/?key=...&secret=...
LSC_URI_BACKUP=lightning+swapconnect://backup.example/?key=...&secret=...
```

While the primary answers, OpenReceive uses only the primary for catalogs,
quotes, and creates. The backup is consulted only when the primary is down
(network/API failure). A healthy primary that simply omits an asset does not
fail over to the backup for that asset.

An empty connection is ignored. Keep the secret environment small — the
connection strings, plus at most a few non-secret operational toggles (log
level, documented `OPENRECEIVE_*` overrides):

```dotenv
NWC_URI=nostr+walletconnect://...
LSC_URI_PRIMARY=lightning+swapconnect://...
LSC_URI_BACKUP=
```

Currencies, logging, route prefixes, callbacks, and other ordinary application
settings do not belong in these variables. Put those in your framework's
normal tracked configuration: a Node configuration module or a Rails
initializer.

The OpenReceive libraries read `process.env` or `ENV`; they do not find or load
a `.env` file themselves. Application entry points may load one for local
development. Production should supply the same variables through its secret
manager or process environment.

URI grammar and security for swap connections:
[Lightning Swap Connect](lightning-swap-connect.md).
