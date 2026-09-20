# Settlement reconciliation

The integrator-facing version of this material is the public
[Deploying OpenReceive](../guides/deploying.md) guide; this page keeps the
contributor-level invariants.

The default settlement driver is the request path: every mounted OpenReceive payment route
(never `GET /rates`) runs one
opportunistic reconcile pass when payment attempts are pending. Every scan entry point — this
request-path pass, the notifications worker's periodic pass, and a directly driven
reconciler — claims the gate first. A durable gate row —
`openreceive_meta` key `transaction_scan_gate` in the host database, claimed by optimistic
CAS — serializes passes across every instance and Puma worker, so rapid calls collapse to one
real wallet scan per interval. The interval floors at 2 seconds
(`OPENRECEIVE_MIN_RECONCILE_INTERVAL_SECONDS`) and stretches with pending-invoice age (2 s
while any pending invoice is under 2 minutes old, 6 s under 5 minutes, else 12 s). The gate is
the NWC scan budget: open tabs polling `payments/check` share the one global pass, and when
User A closes the tab, User B's later call wins the gate and settles A's invoice. The winner
awaits one bounded pass (9 s scan timeout, capped pages) — serverless-safe, since no timer
outlives the request; a failed or timed-out scan warns and never fails the user's request, and
the gate's `claimed_at` stays in place so a broken wallet cannot stampede.

The gate now persists versioned bounded scheduler progress in the existing metadata
row: a keyset position, at most two cohorts of 200 attempts, fixed time bounds,
page offsets and nonsecret overlap digests. Rotate the cohort before wallet I/O.
CAS checkpoints require the current unexpired lease token, so abandoned or stale
workers cannot replace newer progress. A capped or failed pass cannot repeatedly
pin selection to the oldest cohort. Wallet-derived creation times permit bounded
splits; legacy/host-clock rows use the wide fallback. Resumed offsets never prove
absence because history is mutable. Only a fresh complete covering scan can close
an attempt by the clock. Positive finality can be committed before a later page
fails, with ordinary reference-level fulfillment locking.

The BTCPay plugin persists invoice connection identity and recovery eligibility in
its own host database tables. Historical BTC-LN and BTC-LNURL rows are resolved
through canonical host mappings, returned to the connection's coordinated scan
memo, and acknowledged only against the exact host payment row. The host owns
partial, late and overpayment accounting. See the plugin's
[payment safety upgrade procedure](../../packages/dotnet/BTCPayServer.Plugins.OpenReceive/PAYMENT-SAFETY-UPGRADE.md).
Its scan memo remains per connection and process; this is not a cluster-wide
provider or wallet quota. Swap poll leases are durable and prevent duplicate row
claims; provider request-weight budgets are per process/configured connection.

OpenReceive scans shared creation-time ranges rather than walking wallet history once per hash.
Failed callbacks leave the attempt `pending` and are retried on the next pass or after restart.
Pending results are mutable; settled facts are final and never overwritten. Closure of an
unpaid attempt requires a successful scan at or after expiry plus
`OPENRECEIVE_ATTEMPT_EXPIRY_GRACE_SECONDS` (900) — never the local clock alone.
