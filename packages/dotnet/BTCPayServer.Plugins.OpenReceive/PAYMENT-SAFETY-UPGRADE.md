# Payment safety upgrade

Stop every BTCPay web/worker replica, back up the host database, install the updated
plugin, and start the updated replicas together. BTCPay runs the additive EF
migrations through its startup workflow. Do not run old workers with the new
`retired_at` offered-attempt index. A binary rollback cannot interpret this schema
safely; keep the backup and use a forward repair or restore the coordinated backup.
Existing hashes, accepted refund addresses, provider tokens and host payments are
preserved. No plugin publishing or Plugin Builder submission is part of this change.

## Upgrading the original single-table installation

An existing installation with only `openreceive_swaps` upgrades in place. The
startup task checks the plugin's EF migration history and applies the missing
migrations in order, before payment workers start:

1. `20260920000000_MintedInvoices` creates `openreceive_invoices`; it does not
   rename, replace, truncate or copy over `openreceive_swaps`.
2. `20260921000000_PaymentSafetyRecovery` adds recovery fields and indexes to both
   tables. Existing rows receive nullable fields or safe defaults. The offered
   swap index is rebuilt to exclude retired attempts; no payment table is dropped.
3. `20260921000001_RecoveryBindingAudit` adds the optional legacy-account review note.

Every original swap column is preserved, including provider credentials, accepted
refund addresses, transaction IDs, amounts and state. Previously superseded swaps
are marked retired and due for provider refresh; genuinely refunded/failed rows
are not generally reactivated. BTCPay's own invoice/payment tables are untouched.
Subsequent restarts skip already applied migrations. No manual table creation or
separate migration runner is needed. An original-schema table with a missing
initial migration-history record is also safely adopted by `InitialSwaps`.

The new invoice table starts empty for single-table installations: the migration
does **not** invent historic mint rows or infer their original wallet from current
settings. A pre-upgrade hash that BTCPay still requests retains the wallet
lookup/history fallback. Fully automatic recovery of a superseded old hash that
BTCPay no longer requests requires a persisted mint and proven host/account
mapping; the schema upgrade alone cannot reconstruct those missing records.
Existing swaps keep their provider/refund recovery independently of this table.

For users who already have the earlier `openreceive_invoices` table, its rows are
preserved. Missing connection identities remain unset and require the reviewed
binding procedure below; a wallet that happens to be configured now is not proof
of which account originally issued an invoice.

## Historical Lightning invoices

Each new mint records its wallet service and connection public keys before payer
instructions leave the server. Recovery resolves the original BTC-LN or BTC-LNURL
method through BTCPay's `AddressInvoices` mapping, batches at most 200 due rows,
and restores them to the connection's existing coordinated scan memo. A superseded
prompt and an elapsed deadline do not discard its payment evidence. Missing linkage
is retried after host commit; conflicting methods stay unresolved. LNURL requires
its positive-amount callback and LUD21 hash indexing for reconstructable history.

BTCPay's exact `(payment_hash, payment_method_id)` payment row is acknowledgment.
A null `PaymentService.AddPayment` result is reread and checked; it is not assumed
to mean duplicate. The plugin asks BTCPay to recalculate via `InvoiceNeedUpdateEvent`
after host insertion, including after a crash. It never replays `ReceivedPayment`
for acknowledged recovery, which would cause extra partial-payment remints.
The update-needed checkpoint is conservatively retained and revisited hourly:
an event enqueue is not durable completion, and BTCPay's startup sweep excludes
some expired invoices. BTCPay owns partial, overpaid and late-payment accounting;
the plugin does not change an expired invoice to paid itself.

Legacy mints lacking a connection identity remain visible with
`connection_identity_missing`. The current wallet configuration does not prove the
original account after a wallet change. A missing LUD21 mapping remains
`host_mapping_missing`; descriptions or a current prompt cannot reconstruct it.
A host payment that already exists can still trigger accounting repair without
asking an unidentified wallet about the hash.

Dry-run report (run only through the host's trusted maintenance connection):

```sql
SELECT payment_hash, store_id, host_invoice_id, payment_method_id,
       recovery_reason, created_at, expires_at, next_recovery_at
FROM "BTCPayServer.Plugins.OpenReceive".openreceive_invoices
WHERE recovery_closed_at IS NULL AND recovery_reason IS NOT NULL
ORDER BY next_recovery_at, payment_hash
LIMIT 200;
```

For a specifically reviewed legacy row, verify its canonical host mapping and the
original account from saved configuration/history. Obtain the nonsecret connection
identity from a verified mint using that same account (`wallet-public-key:client-public-key`).
Never paste an NWC code into maintenance SQL, shell arguments or an audit note.
After review, the following parameterized transaction binds only the selected,
previously unbound row and retains the review note. Keep the report with your host
maintenance records. Requeue does not credit a payment: ordinary wallet finality
and the host's conditional payment insert still apply.

```sql
BEGIN;
SELECT payment_hash FROM "BTCPayServer.Plugins.OpenReceive".openreceive_invoices
WHERE payment_hash = $1 AND connection_id IS NULL AND recovery_closed_at IS NULL
FOR UPDATE;
UPDATE "BTCPayServer.Plugins.OpenReceive".openreceive_invoices
SET connection_id = $2, recovery_binding_note = $3, next_recovery_at = 0
WHERE payment_hash = $1 AND connection_id IS NULL AND recovery_closed_at IS NULL;
COMMIT;
```

Rows with missing or ambiguous host mapping need host-level review. Never invent a
mapping or bind another wallet merely to make a report empty. These repairs cannot
reconstruct a provider token or host fulfillment record that was never committed.

## Swap recovery and polling

Replacement first refreshes the old provider order. A funded or refund-required
order remains the active recovery view. An unfunded replacement retires the old
instructions and inserts the new order atomically, with PostgreSQL `xmin` checks.
Retired orders remain polled and refundable. Previously superseded rows receive
an explicit refresh marker during migration; their old `expired` state is not
assumed to prove provider finality. A failed/uncertain insertion withholds new
instructions; committed provider-order identity is reread without minting again.
A crash before a provider token was ever persisted is not recoverable unless the
provider itself offers a recovery mechanism; that unexposed order is not evidence
of a payer deposit.

`last_polled_at` records a real provider attempt, `last_observed_at` a successful
observation, and `next_poll_at` its next eligibility. Atomic 90-second database
leases prevent concurrent workers from polling the same row; abandoned claims
become eligible after expiry. A local weight-budget refusal does not advance
last-polled order or pretend the provider was contacted. Refused rows wait until
the relevant budget/backoff boundary and retain priority over recently served
rows. With 400 due orders, no other traffic and a 200-request window, each receives
an actual observation within two 60-second windows. Sustained arrivals queue
behind older attempts; network errors consume capacity and retain the normal
backoff. No finite latency bound is promised when arrival rate exceeds capacity.

The request-weight guard is **per process and configured provider connection**,
shared by that connection's quote/create/status/refund requests. Restart resets
it and replicas multiply its local capacity. Database row leases do not create a
cluster-wide account quota. The provider remains the global rate-limit authority;
HTTP 429 imposes backoff. Separate configured accounts continue independently.

Payers can always use `/plugins/openreceive/invoices/{invoiceId}/recovery`, linked
from both checkout extensions and merchant invoice details. It reloads bounded,
invoice-scoped attempt lists from the server, including retired attempts, even
when swaps are disabled or the invoice is partial, paid or expired. The invoice ID
remains BTCPay's existing bearer boundary. Refund confirmation refreshes the
original provider and preserves the first accepted address. Missing configuration
requires restoring that original provider; it does not erase the order or switch
providers. The recovery page never mints new deposit instructions.

## Verification

`npm run test:dotnet` runs component/vector tests in Docker. Set
`OPENRECEIVE_DOTNET_POSTGRES` to a dedicated PostgreSQL test database to exercise
actual `xmin`, replacement transactions and competing poll leases (otherwise that
lane explicitly skips). Upgrade tests start from the original single-table schema,
that schema without its initial history entry, and the earlier two-table schema;
they compare every original swap field, repeat the actual startup runner and
write a new mint through the upgraded model. The running Docker stack is exercised by
`npm run test:e2e:btcpay -- payment-safety.spec.ts`, including partial-payment remint,
LN/LNURL payment while the host is stopped, recovery after expiry, duplicate restart
and browser refund navigation. Use the disposable testkit wallet/provider only.
