# Settlement reconciliation

The public [Deploying OpenReceive](../guides/deploying.md) guide covers this material for
integrators. This page keeps the invariants contributors must preserve.

The request path is the default settlement driver. Every mounted OpenReceive payment route
runs one opportunistic reconcile pass when payment attempts are pending. `GET /rates` never
does.

Every scan entry point claims the gate first. There are three entry points:

- the request-path pass,
- the notifications worker's periodic pass,
- a directly driven reconciler.

The gate is a durable row in the host database: `openreceive_meta` key
`transaction_scan_gate`. Passes claim it with an optimistic compare-and-swap (CAS), so only
one pass runs at a time across every instance and Puma worker. Rapid calls collapse to one
real wallet scan per interval.

The interval has a floor of 3 seconds (`OPENRECEIVE_MIN_RECONCILE_INTERVAL_SECONDS`). It
grows with the age of the pending invoices:

- 3 s while any pending invoice is under 2 minutes old,
- 6 s while any is under 5 minutes old,
- 12 s otherwise.

The gate is the NWC scan budget. Open tabs polling `payments/check` share the one global
pass. When User A closes the tab, User B's later call wins the gate and settles A's invoice.

The winning call awaits one bounded pass: a 9 s scan timeout and a capped number of pages.
This is safe on serverless hosts, because no timer outlives the request. A page still in
flight at the deadline is cut. When earlier pages answered, the pass ends there and keeps
their progress, and the next pass resumes after them. When none did, the pass fails. A
failed scan logs a warning and never fails the user's request. The gate's `claimed_at` stays in
place, so a broken wallet cannot cause a stampede of retries.

The gate stores versioned, bounded scheduler progress in the same metadata row:

- a keyset position (the cursor where the next pass resumes),
- at most two cohorts of 200 attempts,
- fixed time bounds,
- page offsets,
- nonsecret overlap digests.

Rules for this progress:

- Rotate the cohort before any wallet I/O.
- CAS checkpoints require the current, unexpired lease token. Abandoned or stale workers
  therefore cannot replace newer progress.
- A capped or failed pass cannot keep pinning selection to the oldest cohort.
- Creation times that come from the wallet allow bounded windows and splits. Legacy rows and
  rows timed by the host clock use the wide fallback: the whole wallet history, from 0. They
  get their own cohort, so that walk never widens the window of wallet-timed attempts.
- The cursor moves only past attempts already queued or admitted to a cohort. An attempt whose
  clock source has no free cohort slot is read again by the next selection, never skipped.
- Resumed offsets never prove that a payment is absent, because wallet history is mutable.
- A resumed slice re-reads its last page first, as an overlap. When that overlap is the only
  page the slice answers, it is spent, and the next slice reads the unseen page first. A
  wallet that answers one page per slice still advances.
- Only a fresh, complete scan that covers the attempt's time range can close an attempt by the
  clock.
- Positive finality can be committed before a later page fails. Fulfillment still uses the
  ordinary lock per `reference`.

The BTCPay plugin stores each invoice's connection identity and recovery eligibility in its
own tables in the host database. Historical BTC-LN and BTC-LNURL rows are resolved through
canonical host mappings and returned to the connection's coordinated scan memo. They are
acknowledged only against the exact host payment row. The host owns the accounting for
partial, late, and overpayments. See the plugin's
[payment safety upgrade procedure](../../packages/dotnet/BTCPayServer.Plugins.OpenReceive/PAYMENT-SAFETY-UPGRADE.md).

The scan memo is still per connection and per process. It is not a cluster-wide provider or
wallet quota. Swap poll leases are durable and stop two workers from claiming the same row.
Provider request-weight budgets are per process and per configured connection.

- OpenReceive scans shared creation-time ranges. It does not walk wallet history once per hash.
- A failed callback leaves the attempt `pending`. The next pass, or the next restart, retries it.
- Pending results can change. Settled facts are final and are never overwritten.
- Closing an unpaid attempt requires a successful scan at or after expiry plus
  `OPENRECEIVE_ATTEMPT_EXPIRY_GRACE_SECONDS` (900). The local clock alone is never enough.
