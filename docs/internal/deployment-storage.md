# Deployment state

The integrator-facing version of this material is the public
[Deploying OpenReceive](../guides/deploying.md) guide; this page keeps the
contributor-level invariants.

OpenReceive has no separate deployment storage service. Scaling web instances requires the same
receive-only NWC configuration and access to the host database on each instance.

The library serializes attempt insertion per reference (Postgres advisory lock or SQLite immediate
transaction), enforces unique `payment_hash`, and makes settlement write-once inside the host
database it is handed. No reconciler process is required: every instance participates in
request-path opportunistic reconcile through the shared `openreceive_meta` gate row (durable,
in the host database), which serializes wallet scans across instances; the optional
notifications worker is one extra process, not per-instance. Passes scan only `pending`
attempts, so restarts and overlapping passes repeat bounded, idempotent work.

Process-local rate, provider-weight, and deduplication caches are performance controls only.
Restarting or splitting instances may cause extra calls or duplicate callbacks, never lost
durable truth.
