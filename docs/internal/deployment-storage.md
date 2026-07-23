# Deployment state

OpenReceive has no separate deployment storage service. Scaling web instances requires the same
receive-only NWC configuration and access to the host database on each instance.

The host database must serialize attempt insertion on the order row, enforce unique
`payment_hash`, and provide a write-once paid transition. Host jobs select unresolved payment
rows and call reconciliation. A broad watcher can also emit wallet settlements; hosts ignore
hashes they do not own.

Process-local rate, provider-weight, and deduplication caches are performance controls only.
Restarting or splitting instances may cause extra calls or duplicate callbacks, never lost
durable truth.
