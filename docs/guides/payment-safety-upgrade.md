# Payment safety upgrade and repair

To upgrade:

1. Stop the old workers.
2. Back up the host database.
3. Upgrade the backend and checkout packages together.
4. Rebuild your frontend assets.
5. Restart all web and notification workers.

The payment table shape is unchanged for Node, Rails, Python and PHP. The
durable scan gate now holds versioned leases and bounded progress. Running old
and new workers side by side is not supported. If the gate holds a progress
version from a future release, the library fails closed instead of guessing. Do
not delete payment rows or reset their statuses to make an upgrade run.

BTCPay needs additive migrations and has its own
[upgrade and recovery procedure](https://github.com/OpenReceive/openreceive/blob/main/packages/dotnet/BTCPayServer.Plugins.OpenReceive/PAYMENT-SAFETY-UPGRADE.md).
This source change does not include a registry or BTCPay release.

## Payment and instruction deadlines

A swap deposit deadline only controls when to stop showing the deposit address.
Reconciliation uses the saved Lightning invoice deadline in `checkout_data`.

For example, take a 600-second deposit window and an 1800-second wallet
invoice. An unpaid attempt cannot be closed until a successful covering scan
runs at or after 1800 + 900 seconds. A covering scan is a wallet-history scan
that fully covers the attempt's time window. The 900-second constant is a grace
period for observing payments. It is not extra time to pay.

- Malformed saved wallet deadlines fail visibly and stay unresolved.
- Both `expiresAt` and legacy `expires_at` snapshots keep the wallet deadline.
  Neither falls back to the swap deposit deadline.

The browser keeps monitoring the wallet and refunds after the payer's
instructions expire locally. Provider completion still needs wallet settlement.
Retired swap instructions and refund recovery stay separate. Changing the
checkout identity cancels any work for the old identity.

## Reconciliation progress

Every mounted payment route, scheduled reconciliation pass and notification
fallback shares one gate in the host database. Each pass handles at most 200
pending attempts, reads at most 50 wallet pages, and stops scanning after nine
seconds.

The library takes turns through pending attempts in key order, and saves how far
it got through wallet pages. So later attempts and deep history still get
checked across process restarts. The scan window is narrowed by creation time
only when the saved timestamp came from the wallet. Legacy or host-clock
timestamps use the wider fallback window.

How batches move through the queue:

- A selected batch leaves the saved queue before the library calls the wallet.
- A successful scan that hits the cap saves where to continue.
- A failure or crash frees a slot so newer batches can run. The batch's
  unresolved attempts stay in the ledger for the next turn.
- Selection starts over from the beginning as soon as a batch reaches the
  ledger's current end. So new attempts arriving between passes cannot keep
  pushing older fulfillment retries back forever.

Rules for custom code:

- Custom repositories must fill the requested 200-row page, unless fewer
  pending rows remain after the cursor. A short page tells the library it has
  reached the end of the ledger.
- Python custom wallet clients must honor the internal monotonic `_deadline`
  request value.
- Ruby's bundled adapter enforces that deadline around the wallet RPC. Custom
  Ruby clients must enforce the same deadline.
- This value never belongs in a NIP-47 request.
- You can turn off reconciliation on HTTP requests. The separate worker keeps
  using the same durable gate.

A resumed offset walk can find a final payment state, but it cannot prove that
no payment arrived. Wallet history can change between pages. Closing an attempt
based on the clock needs a fresh, complete covering scan. So dense history that
cannot be split safely may stay pending. It stays pending until the wallet shows
positive evidence or an operator reviews it. Failed, truncated, stale-lease and
unusable scans never prove absence. Only pending attempts change state
automatically.

Before contacting the provider, a refund needs a supported asset and network
from the server's saved swap data. If recovery metadata is missing, the host
must repair it. The payer cannot supply a replacement network. Provider
diagnostic hooks in Node and Ruby now receive allowlisted metadata and presence
flags instead of raw request and response bodies. Update any custom log
consumers to match.

## Custom repository and transaction changes

Node custom repositories must implement
`recordSettlementWithFulfillment(settlement, fulfill)` and `findByPaymentHash`.
The repository must:

- resolve the reference
- settle sibling attempts one at a time
- await `fulfill({ reference, paymentHash, paidAt, details, transaction })`
  inside the same transaction as the payment update

If anything fails, both must roll back. A boolean claim followed by a callback
is no longer supported. `createHost<Transaction>` exposes the host's
transaction type. Database mode still supplies its SQL `query` context.

Default reconciliation also needs lease-based `claimReconcileGate` and
`checkpointReconcileGate`, bounded keyset selection, and durable progress.
Custom repositories without a gate must explicitly turn off opportunistic
reconciliation and handle recovery themselves.

The bundled Node NWC adapter always runs the receive-only preflight. The old
bypass is gone. Custom Node wallet clients must honor the history request's
`AbortSignal`. The bundled SDK transport cancels subscriptions and queued relay
work at the scan deadline.

Django `after_paid` now follows the outermost host transaction. A rollback
discards it. Rails fulfillment takes part in the host transaction and in its own
ActiveRecord `after_commit` workflow. Database fulfillment may run again after
a rollback, but only one fulfillment per reference commits. Post-commit
callbacks are still best effort. Put external effects in a host outbox inside
the settlement transaction. Then send them using the reference as the external
idempotency key. See [fulfillment](api-reference.md#onpaid).

## Review and repair existing attempts

Run these steps from a trusted host maintenance process, not a payer route.
First produce a bounded dry-run report and keep it with the incident record.
Reports contain hashes, references, deadlines, statuses and reasons. They never
contain provider credentials or wallet connection strings.

| Backend | Dry run | Reviewed requeue |
| --- | --- | --- |
| Node SQL | `payments.listRepairCandidates({ limit: 100, after })` | `payments.requeueAttempt({ paymentHash, expectedStatus, expectedUpdatedAt, reason })` |
| Python SQL/Django | `repository.maintenance_candidates(limit=100, after=cursor)` | `repository.requeue_reviewed_attempt(candidate, decision_id="ticket-42")` |
| Rails | `OpenReceivePayment.maintenance_candidates(limit: 100, after: cursor)` | `OpenReceivePayment.requeue_reviewed_attempt!(candidate, decision_id: "ticket-42")` |
| PHP SQL | `$repository->maintenanceCandidates($cursor, 100)` | `$repository->requeueReviewedAttempt($candidate, 'ticket-42')` |

Then:

1. Follow each report's next cursor until there are no more pages.
2. Review early swap closures against the saved wallet deadline.
3. Review `attention` rows against wallet history and the host's order and
   fulfillment records.
4. Requeue only candidates you have explicitly reviewed.

Requeue checks the recorded status and version under the reference lock. It
keeps an audit entry in the existing metadata table and never changes settled
rows. Repeated or stale decisions return false. Requeue does not grant the
order anything. The normal wallet settlement transaction still decides that,
including the rule that fulfillment runs only for the reference's first
settled attempt.

Older Node custom repositories had a callback gap. Because of it, a settled
payment may be missing its host fulfillment. **Do not reset or replay all
settled payments.** For each affected reference, compare it against the host's
entitlement or outbox evidence and its external idempotency records. Repair
only the specific missing host effect, through the host's own transaction or
outbox workflow. OpenReceive cannot tell from a payment row alone whether an
external fulfillment happened.

Keep old swap rows and server-only provider tokens while any refunds or wallet
payments are still unresolved. Some BTCPay legacy rows have no proven
connection or LNURL mapping. For those, follow the plugin report and the
explicit account-binding procedure. Never guess from the current wallet or
checkout prompt. Rolling back binaries requires stopping all workers and a
coordinated restore or forward repair. Do not remove recovery columns or
discard history.
