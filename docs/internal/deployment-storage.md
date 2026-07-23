# Deployment state

OpenReceive has no deployment storage. Scaling web instances requires only the same receive-
only NWC configuration and token keyring on each instance.

The host database must provide a unique/compare-and-set payment-hash write and a write-once
paid transition. Host jobs select unresolved rows and call reconciliation. A broad watcher can
also emit wallet settlements; hosts ignore hashes they do not own.

Process-local rate, provider-weight, and deduplication caches are performance controls only.
Restarting or splitting instances may cause extra calls or duplicate callbacks, never lost
durable truth.
