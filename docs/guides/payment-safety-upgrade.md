# Payment safety upgrade and repair

Upgrade the backend and checkout packages together, rebuild frontend assets, and
restart all web and notification workers. Stop old workers first and back up the
host database. The payment table shape is unchanged for Node, Rails, Python and
PHP; the durable scan gate now carries versioned leases and bounded progress.
Mixed old/new workers are unsupported. An unknown future progress version fails
closed; do not delete payment rows or reset their statuses to make an upgrade run.
BTCPay requires additive migrations and has its own
[upgrade and recovery procedure](https://github.com/OpenReceive/openreceive/blob/main/packages/dotnet/BTCPayServer.Plugins.OpenReceive/PAYMENT-SAFETY-UPGRADE.md).
No registry or BTCPay publication is part of this source change.

## Payment and instruction deadlines

A swap deposit deadline controls when to stop showing its address. Reconciliation
uses the saved Lightning invoice deadline in `checkout_data`. For example, a
600-second deposit window and an 1800-second wallet invoice do not permit closing
an unpaid attempt until a successful covering scan at or after 1800 + 900 seconds.
The 900-second constant is an observation grace period, not extra time to pay.
Malformed saved wallet deadlines fail visibly and remain unresolved.

The browser continues wallet and refund monitoring after local instruction expiry.
Provider completion still needs wallet settlement. Retired swap instructions and
refund recovery remain separate, and changing checkout identity cancels work for
the old identity.

## Reconciliation progress

Every mounted payment route, scheduled reconciliation pass and notification
fallback shares the host database gate. Each pass serves at most 200 pending
attempts with at most 50 wallet pages and a nine-second scan deadline. Keyset
rotation and persisted page progress let later attempts and deep history receive
service across process restarts. Creation-time bounds are narrowed only when the
saved timestamp came from the wallet; legacy or host-clock timestamps use the
wider fallback.

A resumed offset walk can discover finality but cannot prove absence: wallet
history can change between pages. Clock-based closure requires a fresh complete
covering scan. Dense history that cannot be safely split may therefore stay
pending until positive wallet evidence or operator review resolves it. Failed,
truncated, stale-lease and unusable scans never provide absence proof. Only
pending attempts receive automatic transitions.

## Custom repository and transaction changes

Node custom repositories must implement
`recordSettlementWithFulfillment(settlement, fulfill)` and `findByPaymentHash`.
The repository resolves the reference, serializes sibling settlement and awaits
`fulfill({ reference, paymentHash, paidAt, details, transaction })` inside the same
transaction as the payment update. Failure must roll both back. A boolean claim
followed by a callback is no longer supported. `createHost<Transaction>` exposes
the host's transaction type. Database mode still supplies its SQL `query` context.

Default reconciliation additionally requires lease-based `claimReconcileGate`
and `checkpointReconcileGate`, bounded keyset selection, and durable progress.
Custom repositories that provide no gate must explicitly disable opportunistic
reconciliation and arrange their own recovery. The bundled Node NWC adapter
always performs receive-only preflight; the old bypass is removed. Custom Node
wallet clients must honor the history request's `AbortSignal`; the bundled SDK
transport cancels subscriptions and queued relay work at the scan deadline.

Django `after_paid` now follows the outermost host transaction; rollback discards
it. Rails fulfillment participates in the host transaction and its own
ActiveRecord `after_commit` workflow. Database fulfillment may execute again after rollback,
but only one reference fulfillment commits. Post-commit callbacks remain best
effort: put external effects in a host outbox in the settlement transaction, then
send with the reference as the external idempotency key. See
[fulfillment](api-reference.md#onpaid).

## Review and repair existing attempts

Run the following through a trusted host maintenance process, not a payer route.
First produce a bounded dry-run report and retain it with the incident record.
Reports contain hashes, references, deadlines, statuses and reasons; never provider
credentials or wallet connection strings.

| Backend | Dry run | Reviewed requeue |
| --- | --- | --- |
| Node SQL | `payments.listRepairCandidates({ limit: 100, after })` | `payments.requeueAttempt({ paymentHash, expectedStatus, expectedUpdatedAt, reason })` |
| Python SQL/Django | `repository.maintenance_candidates(limit=100, after=cursor)` | `repository.requeue_reviewed_attempt(candidate, decision_id="ticket-42")` |
| Rails | `OpenReceivePayment.maintenance_candidates(limit: 100, after: cursor)` | `OpenReceivePayment.requeue_reviewed_attempt!(candidate, decision_id: "ticket-42")` |
| PHP SQL | `$repository->maintenanceCandidates($cursor, 100)` | `$repository->requeueReviewedAttempt($candidate, 'ticket-42')` |

Follow each report's next cursor until exhausted. Review early swap closures
against the saved wallet deadline, and review `attention` rows against wallet
history and host order/fulfillment records. Select only explicitly reviewed
candidates. Requeue compares the recorded status/version under the reference lock,
keeps an audit entry in the existing metadata table, and never modifies settled
rows. Repeated or stale decisions return false. Requeue grants no entitlement;
the normal wallet settlement transaction still decides it, including a settled
sibling's first-fulfillment protection.

For the former Node custom-repository callback gap, a settled payment may already
have missing host fulfillment. **Do not reset or replay all settled payments.**
Compare each affected reference against the host's entitlement/outbox evidence and
external idempotency records. Repair the specifically missing host effect through
the host's own transaction or outbox workflow. OpenReceive cannot infer whether an
external fulfillment happened from a payment row alone.

Preserve old swap rows and server-only provider tokens while refunds or wallet
payments remain unresolved. For BTCPay legacy rows without a proven connection or
LNURL mapping, follow the plugin report and explicit account-binding procedure;
never guess from the current wallet or checkout prompt. Rolling back binaries
requires stopping all workers and a coordinated restore or forward repair, not
removing recovery columns or discarding history.
