# Settlement reconciliation

The default settlement driver is the request path: every mounted OpenReceive route runs one
opportunistic reconcile pass when payment attempts are pending. A durable gate row —
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

The gate is not a cursor. There is still no OpenReceive-owned sweep database, privileged sweep
route, or durable cursor: each pass selects `openreceive_payments` rows where
`status = 'pending'`, and because terminal rows leave the scan set, the wallet scan window
stays bounded at roughly the active invoice window.

OpenReceive scans shared creation-time ranges rather than walking wallet history once per hash.
Failed callbacks leave the attempt `pending` and are retried on the next pass or after restart.
Pending results are mutable; settled facts are final and never overwritten. Closure of an
unpaid attempt requires a successful scan at or after expiry plus
`OPENRECEIVE_ATTEMPT_EXPIRY_GRACE_SECONDS` (900) — never the local clock alone.
