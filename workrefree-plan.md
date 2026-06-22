# OpenReceive — Definitive Architecture Plan (v2)

**Status:** Proposal / RFC (definitive; supersedes earlier drafts)
**Scope:** Entire OpenReceive repository (`spec`, `packages/js/*`, `packages/ruby/*`, `docs`, `tools`, `examples`, `or-master-plan.txt`)
**Note:** OpenReceive has no users yet. There is **no legacy code or legacy interface to preserve** — every contract here is _the_ contract. Anything in the current tree this plan replaces is deleted, not wrapped.

**v2 incorporates six fixes from review:** (1) `getByBolt11Invoice` restored; (2) typed `putIfAbsent` conflict result + ordered create sequence so replay ≠ collision; (3) settlement is **at-least-once** via a CAS action lease, hooks must be idempotent; (4) **S3 dropped**, gated `local-sqlite` added; (5) active per-invoice lookup split from the background sweep, sweep throttled in the store and run async with hard bounds; (6) the in-memory SSE event bus removed.

**Final review fixes applied:** `invoice_id` collisions are explicit and retried by core; concurrent identical creates may rarely mint an abandoned extra wallet invoice, which is acceptable because only one invoice is stored/returned and only stored invoices can fulfill; Redis/DO uniqueness reservations must be atomic (repair is for stale indexes only); `/events`/AsyncAPI become optional, not unchanged; lookup endpoints are documented as **gated status refreshes** that may return stored state without a wallet call.

---

## The three principles

1. **Self-owned persistence.** OpenReceive does not integrate with the app's database through its framework/ORM. It opens **its own connection** to a durable store named by a single `OPENRECEIVE_STORE` URI (or a platform binding), owns **one frozen opaque-blob keyspace**, **self-initializes on boot**, and supports **multiple instances on one store** via a namespace.
2. **No worker, no listener, no in-memory coordination.** The default deployment is **mount routes + set two env vars**. There is no daemon, no required cron, no NWC notification listener, and **no in-memory coordination state** — because a real server runs **multiple workers** (Puma/Unicorn forks, Node cluster, horizontal replicas) that don't share memory. The **durable store is the sole coordination point.** Settlement is **poll-only** — discovered exclusively by `lookup_invoice`.
3. **NWC is the only wallet protocol, and it is rate-limited in the store.** Our own store is cheap and unthrottled; `lookup_invoice` is scarce. Two **store-enforced gates** bound wallet load across every invoice and every worker: a **per-invoice cooldown** and a **global token bucket**. Both the interactive lookup endpoint and the background sweep go through them.

Existing posture (no frontend NWC, server-side receive-only wallet, OpenReceive holds no funds) is unchanged.

---

## 0. TL;DR

- Store contract is a **9-method dumb key-value contract** (7 for invoice records, 2 generic control-row primitives). The invoice state machine lives in core as plain functions; there is **no stateful repository interface** and **no `mark*` methods on the store**.
- OpenReceive talks to Postgres / MySQL / SQLite / Redis / Durable Object storage via **its own driver** — never the app's ORM. No ActiveRecord/Prisma/Drizzle model, no per-framework migration. **S3/object storage is out** (atomic uniqueness across separate objects is a reservation protocol we won't certify in v1).
- Each record is the full invoice row as **opaque JSON + a `rev`**. SQL tables carry ~5 control columns + one `data` blob. **The schema is frozen — never a second migration.**
- Config is a single `OPENRECEIVE_STORE=<uri>`. Boot resolves the scheme, connects, runs an idempotent `ensureSchema()`. **No hand-run `migrate` step.** A `local-sqlite` convenience auto-creates a gitignored per-namespace file for **single-machine self-hosting**.
- `OPENRECEIVE_NAMESPACE` (default `default`) lets many instances share one store. `merchant_scope` provides logical isolation within an instance.
- Boot uses `CREATE TABLE IF NOT EXISTS` + an **ownership/version guard**. Refuses **only** on a foreign same-named table or a newer on-disk schema — **never** because our own table already exists.
- **Recovery is poll-only and worker-free.** The interactive lookup endpoint checks **one** invoice through the two gates; a separate, store-throttled, async background **sweep** catches up abandoned invoices. No listener, no webhook, no in-memory state.
- **Settlement is at-least-once.** A CAS **action lease** prevents concurrent double-execution and recovers crashed claims, but a crash _after_ the hook runs and _before_ OpenReceive marks completion can replay the effect. **Settlement hooks MUST be idempotent/duplicate-safe**, deduplicated by `payment_hash`.
- Backends are keyed by **transport**, not framework — ~5 adapters shared across every framework. Framework packages shrink to a route adapter + an optional one-shot poll entrypoint.

---

## 1. Why — the diagnosis (grounded in the current code)

The complexity in the current tree is not the cost of persistence. It is two design choices.

**(a) The store contract conflates persistence with the state machine.**
`packages/js/core/src/storage/index.ts` defines `OpenReceiveInvoiceStore` with **16 methods**, 9 of which are typed state transitions, each embedding guards (e.g. `if (row.transaction_state !== "settled") …`). That logic is **re-implemented in every backend**: `InMemoryInvoiceStore` (core), `postgres-store.ts` (~613 lines), `sqlite-store.ts` (~619 lines). A new backend re-derives the state machine.

**(b) Persistence is framework/ORM-coupled by doctrine.**
`migrations/001_create_openreceive_invoices.postgres.sql` is a hand-written table with **17 typed columns + 7 `CHECK` constraints + 2 indexes + a `schema_migrations` table**. `cli.ts` (1,128 lines) hard-codes `--sqlite`/`--postgres`; `doctor` inspects `REQUIRED_INVOICE_COLUMNS` (20), `REQUIRED_INVOICE_INDEXES` (2), `REQUIRED_STORE_METHODS` (16). The Rails package ships an ActiveRecord `openreceive_invoice.rb` model + a `create_openreceive_tables.rb` migration. `or-master-plan.txt` ("Persistence ownership") commits to OpenReceive living _inside the app's database_, run via _"the package migration"_, with _"the native persistence shape for its ecosystem"_ (ActiveRecord, Django+Alembic, Eloquent/Doctrine…). **This is the N-frameworks × M-ORMs surface to delete.**

**The enabling fact:** `packages/js/core/src/runner/index.ts` already orchestrates the lifecycle in core (`applyPollingOutcome`, `runSettlementActionOnce`, `recoverOpenInvoices`, `isFinalInvoice`); decisions live in `core/polling` and `core/settlement`. The state machine is **almost** in core already; the guards just got copied into the backends.

---

## 2. Goals and non-goals

**Goals**

- One durable contract any transport satisfies (SQL, Redis, Durable Object storage).
- Zero hand-run migrations; self-initialization on boot.
- Multiple instances safely share one store.
- **No worker, no listener, no in-memory state**; correct under multi-worker servers.
- Adding a transport is ~120 lines + a green conformance run.
- Framework packages stop shipping ORM models/migrations.

**Non-goals**

- Removing persistence (irreducible for money-safety: permanent paid record + preimage proof). We make it _tiny and framework-free_, not optional.
- Push-based settlement. No NWC listener, no webhook bridge — both need a long-running process or external infra. Settlement is poll-only.
- **Exactly-once settlement.** Impossible without a distributed transaction; we provide at-least-once + a lease and require idempotent hooks.
- **S3/object storage in v1.** Deferred until SQL/Redis/DO are proven and a reservation/recovery protocol is specced.
- Changing the public HTTP contract (`/openreceive/v1`, lookup by `payment_hash` **or** `invoice`), the NWC receive-only posture, or the product boundary.

---

## 3. Target architecture

```
                         ┌─────────────────────────────────────────────┐
   browser/mobile  ──►   │  HTTP routes  (/openreceive/v1)              │   framework adapter
   (display-safe)        │  - create                                   │   (express/next/rails/…)
   3s poll  ───────────► │  - lookup ONE invoice (gated)               │   ← interactive path
                         │  - async background sweep (store-throttled) │   ← recovery path
                         └───────────────┬─────────────────────────────┘
   optional cron ──►─────────────────────┘  (platform scheduler → /poll; not a daemon)
                                         │ calls
                         ┌───────────────▼─────────────────────────────┐
                         │  CORE  (backend-agnostic; the ONLY logic)    │
                         │  - state machine (plain functions)           │
                         │  - idempotency rules (replay vs conflict)     │
                         │  - gatedLookup(invoice)  →  cooldown+bucket  │
                         │  - reconcileSweep(limit) →  listOpen + gates │
                         │  - settlement action LEASE (at-least-once)   │
                         └───────────────┬─────────────────────────────┘
                                         │ uses 9-method KV contract (sole coordination point)
                         ┌───────────────▼─────────────────────────────┐
                         │  OpenReceiveInvoiceKvStore  (dumb persistence)│
                         │  records: putIfAbsent / put(rev) / get /      │
                         │   getByPH / getByBolt11 / getByScope/listOpen │
                         │  control: getMeta / casMeta(rev)             │
                         └───────────────┬─────────────────────────────┘
                                         │ one adapter per TRANSPORT (shared across all frameworks)
        ┌──────────────┬─────────────────┼──────────────────┬───────────────────────┐
     postgres        mysql            sqlite              redis            durable-object
   (own pg conn)  (own conn)   (1 machine, WAL)      (SET NX, optional)   (txn storage)

   NO S3.  NO NWC listener.  NO webhook.  NO in-memory state / SSE bus.
   Settlement discovered ONLY by gated lookup_invoice, paced by two store-enforced gates.
   Settlement action is AT-LEAST-ONCE (lease + idempotent hooks).
```

Core owns _all_ logic. The store is a dumb durable map and the single point every worker coordinates through.

---

## 4. The store contract

`packages/js/core/src/storage/kv.ts`:

```ts
export interface StoredRecord {
  rev: number; // monotonic; 0 on first write
  row: InvoiceStorageRow; // full invoice row, incl. last_lookup_at + action_claimed_at (§6)
}

export interface MetaRow {
  value: string;
  rev: number;
} // value is opaque (JSON for structured rows)

export interface OpenReceiveInvoiceKvStore {
  // ── invoice records ──────────────────────────────────────────────
  /**
   * Atomic put-if-absent across invoice_id AND the three uniqueness keys.
   * On collision, reports WHICH key collided and returns the existing record,
   * so core can distinguish retryable invoice_id collision, replay
   * (idempotency_scope), and conflict (payment_hash/bolt11).
   */
  putIfAbsent(
    record: StoredRecord,
  ): MaybePromise<
    | { status: "created"; record: StoredRecord }
    | {
        status: "conflict";
        on: "invoice_id" | "idempotency_scope" | "payment_hash" | "bolt11";
        existing: StoredRecord;
      }
  >;

  /** Optimistic update keyed by invoice_id; rejects if stored rev != expectedRev. */
  put(
    record: StoredRecord,
    expectedRev: number,
  ): MaybePromise<{ status: "ok" | "conflict"; record: StoredRecord }>;

  get(invoiceId: string): MaybePromise<StoredRecord | undefined>;
  getByPaymentHash(paymentHash: string): MaybePromise<StoredRecord | undefined>;
  getByBolt11Invoice(invoice: string): MaybePromise<StoredRecord | undefined>; // RESTORED (HTTP lookup-by-invoice)
  getByIdempotencyScope(
    scopeKey: string,
  ): MaybePromise<StoredRecord | undefined>;

  /** Recovery scan: non-terminal records, hard-bounded. SQL WHERE, or prefix scan of the open-index. */
  listOpen(input: { now: number; limit: number }): MaybePromise<StoredRecord[]>;

  // ── generic control rows (ownership/version, lookup bucket, sweep clock) ──
  getMeta(key: string): MaybePromise<MetaRow | undefined>;
  /** Compare-and-set. expectedRev = null means create-if-absent. */
  casMeta(
    key: string,
    value: string,
    expectedRev: number | null,
  ): MaybePromise<{ status: "ok" | "conflict"; row: MetaRow }>;
}
```

Nine methods, **all pure persistence** — no guards, no transitions. Per-invoice cooldown and the action lease reuse `put` (both fields live on the record). The token bucket, sweep clock, and ownership guard use `getMeta`/`casMeta`. Optional adapter lifecycle: `ensureSchema()`, `close()`, `repairIndexes()`.

There is **no second store interface.** The runner consumes core functions (§5), which consume this contract directly.

---

## 5. State machine + action lease in core (no repository, no shim)

The 9 transitions become **plain pure functions in core**:

```ts
// packages/js/core/src/state/transitions.ts
export function applySettled(rec, settledAt?): StoredRecord;
export function applyExpiredClosed(rec): StoredRecord;
export function applyFailedClosed(rec): StoredRecord;
export function applyVerifying(rec): StoredRecord;
export function applyExpiryPendingVerification(rec): StoredRecord;
export function markLookupAttempted(rec, now): StoredRecord; // sets last_lookup_at (gate 1)
export function claimSettlementAction(rec, now): StoredRecord; // sets action_claimed_at (lease)
export function clearSettlementActionClaim(rec): StoredRecord; // on hook failure → retryable
export function applySettlementActionCompleted(rec, at): StoredRecord; // terminal
```

Each applies the guard and returns the next record (`rev + 1`); the runner persists via `store.put(next, rec.rev)` and retries on `"conflict"`. `validateInvoiceStorageRow`, `canonicalJson`, `createIdempotencyRequestHash`, `idempotencyScopeKey` stay in core as the single source of constraint truth — the 7 SQL `CHECK` constraints move into core validation and out of every dialect. The state machine has exactly **one implementation, in core**; backends never contain transition logic.

### 5.1 Settlement action lease (at-least-once)

OpenReceive cannot guarantee exactly-once external effects without a distributed transaction across its store and the app's store. It guarantees **at-least-once with no _concurrent_ duplicate**, and recovers crashed claims, via a CAS lease on the record (`settlement_action_state` + `action_claimed_at`):

```
runSettlementAction(rec, now):
  if rec.row.settlement_action_state == "completed": return            // done
  if rec.row.action_claimed_at and now - rec.row.action_claimed_at < ACTION_LEASE_TTL:
      return                                                            // another worker holds the lease
  claim = store.put(claimSettlementAction(rec, now), rec.rev)          // CAS-claim the lease
  if claim.status == "conflict": return                                // lost the claim → another worker has it
  try:
    settlementAction({ invoice_id, payment_hash, metadata, lookup_invoice })   // the app hook
  catch e:
    store.put(clearSettlementActionClaim(claim.record), claim.record.rev)       // release → retried later
    throw e
  store.put(applySettlementActionCompleted(claim.record, now), claim.record.rev) // mark terminal
```

The lease **eliminates concurrent double-execution** (the common duplicate across workers/sweeps) and **recovers a crashed claim** (after `ACTION_LEASE_TTL`, another worker re-claims and re-runs). What it cannot eliminate: a crash _after_ the hook returns but _before_ the completion write — the next sweep re-claims and re-runs the hook. Therefore:

> **The settlement hook is delivered at-least-once and MUST be idempotent / duplicate-safe.** OpenReceive passes `invoice_id` + `payment_hash` as the natural dedup key. Recommended hook shape: a conditional effect, e.g. `UPDATE orders SET paid = true WHERE id = ? AND paid = false`, or dedupe on `payment_hash`. This is the Stripe-webhook posture: at-least-once, you dedupe by id.

`ACTION_LEASE_TTL` is configurable (default ~60s) and should exceed expected hook duration.

---

## 6. Canonical record + storage layout per transport

One canonical record = `{ rev, row }`, where `row` is `InvoiceStorageRow` plus two fields, **both in the opaque blob** (the sweep/lookup already hold the record):

- `last_lookup_at?: number` — Unix seconds of the most recent `lookup_invoice` attempt (gate 1).
- `action_claimed_at?: number` — Unix seconds the settlement-action lease was claimed (§5.1).

### SQL (Postgres / MySQL / SQLite) — control columns + opaque blob

```sql
-- namespaced: <ns>_openreceive_invoices  (see §9)
CREATE TABLE IF NOT EXISTS <ns>_openreceive_invoices (
  invoice_id        TEXT     PRIMARY KEY,
  rev               BIGINT   NOT NULL,
  payment_hash      TEXT     NOT NULL UNIQUE,
  bolt11            TEXT     NOT NULL UNIQUE,
  idempotency_scope TEXT     NOT NULL UNIQUE,   -- merchant_scope:operation:idempotency_key
  terminal          BOOLEAN  NOT NULL DEFAULT FALSE,
  expires_at        BIGINT   NOT NULL,
  data              JSONB    NOT NULL            -- the whole {rev,row} record, opaque
);
CREATE INDEX IF NOT EXISTS <ns>_openreceive_open_idx
  ON <ns>_openreceive_invoices (terminal, expires_at);

CREATE TABLE IF NOT EXISTS <ns>_openreceive_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  rev   BIGINT NOT NULL DEFAULT 0
);
```

Five control columns the engine needs (uniqueness × 3, recovery scan × 2) + one opaque `data`. **Schema frozen forever.** MySQL: `JSON`/`TINYINT(1)`. SQLite: `TEXT`/`INTEGER`, **WAL mode** (so multiple local processes — Puma/Unicorn workers on one box — share it safely; `rev` CAS works across processes via SQLite's inter-process locking).

### Redis / Durable Object storage — tiny keyspace the adapter maintains

```
<ns>/inv/<invoice_id>      -> {rev,row} JSON
<ns>/ph/<payment_hash>     -> invoice_id          (secondary index)
<ns>/b11/<sha256(bolt11)>  -> invoice_id          (secondary index; hash to bound key length)
<ns>/idem/<scopeKey>       -> invoice_id          (secondary index)
<ns>/open/<invoice_id>     -> ""                   (presence marker; listOpen = bounded prefix scan)
<ns>/_meta/<key>           -> {value,rev}          (ownership/version, lookup_bucket, last_sweep_at)
```

`listOpen` is `WHERE terminal = false LIMIT ?` on SQL and a bounded prefix scan of `<ns>/open/` on Redis/DO. The adapter writes the `open/` marker in `putIfAbsent` and deletes it when the row becomes terminal.

---

## 7. Idempotency + uniqueness — the precedence rule and the create sequence

Idempotency rides on **atomic `putIfAbsent`** across `invoice_id`, `payment_hash`, `bolt11`, `idempotency_scope`; the bucket, sweep-clock, and ownership rows ride on **atomic `casMeta`**. The store reports _which_ key collided so core applies ADR-0003 precedence: **idempotency scope is decided first (replay-or-409), retryable `invoice_id` collision second, wallet-value uniqueness third.**

**Invoice-create sequence (in core):**

```
1. scopeKey = merchant_scope:operation:idempotency_key ; requestHash = sha256(canonicalJson(request))
2. existing = getByIdempotencyScope(scopeKey)
   if existing:
       existing.idempotency_request_hash == requestHash  → 200 REPLAY (return existing)  ──┐ never call make_invoice
       else                                               → 409 idempotency-conflict       ──┘
3. mint via NWC make_invoice → bolt11, payment_hash
4. r = putIfAbsent(record)
   r.created                         → 201
   r.conflict on "invoice_id"        → generate a new invoice_id and retry putIfAbsent with the SAME bolt11/payment_hash
                                       (retryable local id collision; never call make_invoice again)
   r.conflict on "idempotency_scope" → re-read; apply step-2 hash compare (REPLAY or 409). (race between 2 and 4)
   r.conflict on "payment_hash"|"bolt11" → 409 storage-conflict
       (two logical invoices cannot share a payment_hash/bolt11 — a genuine wallet-value collision or a bug)
```

This makes replay, retryable local-id collision, and wallet-value collision **distinct outcomes**, never blurred. One tradeoff is accepted deliberately: if two workers race with the same idempotency key and neither sees an existing record before calling `make_invoice`, more than one wallet invoice may be minted. Only the `putIfAbsent` winner is stored and returned; the loser re-reads the stored invoice and returns the replay if the request hash matches. The extra wallet invoice is abandoned and expires. That is annoying wallet clutter, not a money-safety bug, because no OpenReceive record or app fulfillment exists for the abandoned invoice.

If a future high-volume merchant or wallet quota makes abandoned invoices costly, OpenReceive can add an optional per-idempotency-scope create lease in `_meta` before `make_invoice`. It is not required for v1 correctness.

Transport primitives:

| Transport                    | Atomic conditional-write primitive                                                         | Notes                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Postgres / MySQL             | `INSERT … ON CONFLICT DO NOTHING` returning the conflicting key / `UPDATE … WHERE rev = ?` | native, strongly consistent                                                    |
| SQLite (single machine, WAL) | same; inter-process locking                                                                | multiple **local** workers OK; cannot span machines or survive ephemeral hosts |
| Cloudflare                   | **Durable Object storage** transaction                                                     | **NOT Workers KV** (eventually consistent, no CAS)                             |
| Redis / Upstash              | one `WATCH`/`MULTI` or Lua operation reserving primary + all indexes                       | native; optional v1                                                            |

A store that cannot provide atomic conditional writes is **not a certified backend.** SQL enforces all four uniqueness keys in one statement/transaction. Redis/DO must reserve/write the primary record and all secondary uniqueness keys **atomically**; they must not write the primary first and rely on later index repair for uniqueness. `repairIndexes()` is only for stale/missing secondary indexes discovered after non-uniqueness maintenance bugs or older data, never part of the correctness path for `putIfAbsent`.

---

## 8. Recovery — poll-only, worker-free, store-coordinated

Two distinct paths share one gated-lookup primitive. Settlement is discovered **only** by `lookup_invoice`; there is **no listener, no webhook, no in-memory state**.

### 8.1 The gated-lookup primitive (used by both paths)

`lookup_invoice` is the scarce resource. Every call passes two store-enforced gates, both `rev`-guarded, both shared across all workers/replicas:

**Gate 1 — per-invoice cooldown.** `last_lookup_at` on the record; `cooldownFor(age)` is the backoff curve (aggressive right after creation — ~1–3s — widening to ~12s, then minutes once old; matches the documented NWC cadence). Claiming the lookup is `store.put(markLookupAttempted(rec), rec.rev)`: only the winning writer proceeds; the loser skips because someone else is handling that invoice. This both paces a single invoice and prevents two concurrent workers double-looking-up one invoice.

**Gate 2 — global token bucket.** Bounds _breadth_ — many distinct due invoices at once. One lazily-refilled bucket row per namespace:

```
<ns>/_meta/lookup_bucket -> { tokens, refilled_at }
tryConsumeLookupToken(now):
  loop (bounded retries):
    m = getMeta("lookup_bucket")
    tokens = min(MAX, m.tokens + (now - m.refilled_at) * REFILL_PER_SEC)   // lazy refill, no timer
    if tokens < 1: return false
    r = casMeta("lookup_bucket", JSON({tokens: tokens-1, refilled_at: now}), m.rev)
    if r.status == "ok": return true
  return false   // contended → skip this lookup this pass
```

`MAX` = burst ceiling, `REFILL_PER_SEC` = sustained rate (both configurable; conservative defaults). **No-refund:** a spent token isn't returned, so a slow/failed lookup is natural backpressure. Because the decrement is an atomic CAS on one shared row, a cold-start flood across many workers draws from **one** budget: at most `MAX` lookups in a burst, then refill-rate; the rest wait.

**The primitive:**

```
gatedLookup(rec, now):
  age = now - rec.row.created_at
  if now < (rec.row.last_lookup_at ?? 0) + cooldownFor(age): return STORED      // gate 1: not due
  if not tryConsumeLookupToken(now):                          return STORED      // gate 2: no token
  claim = store.put(markLookupAttempted(rec, now), rec.rev)
  if claim.status == "conflict":                              return STORED      // another worker has it
  result = nwc.lookupInvoice({ payment_hash: rec.row.payment_hash })             // THE rate-limited call
  advance state machine from result; persist via store.put(next, rev)
  if settled: runSettlementAction(next, now)   // §5.1 lease
  return UPDATED
```

_Ordering_ (cooldown → token → claim → lookup) is deliberate: the cheap cooldown pre-filters so the hot bucket row is touched only for _due_ invoices; the token is spent only when we intend to look up now; the claim then prevents same-invoice duplication. Sole benign edge: two workers targeting the same invoice in the same instant — the claim-loser spent a token without looking up; rare, self-correcting via refill.

### 8.2 Interactive path — the lookup endpoint (browser 3s poll)

The browser checkout polls the lookup endpoint every 3s by default (`packages/js/browser/src/index.ts:2905`). That endpoint refreshes/checks **only the one requested invoice** (by `payment_hash` or `invoice`), via `gatedLookup`. **It never scans.** Because the cooldown is age-based, a _young_ invoice (customer actively waiting) is due roughly every few seconds → responsive confirmation, while an _old_ abandoned invoice is rarely due → mostly cheap stored-state reads. So the 3s poll mostly returns stored state and hits the wallet only when that invoice's cooldown is due and a token is free. A fast or malicious client **cannot** force fast wallet lookups — the gates throttle regardless of poll rate. Docs should describe this route as a **gated status refresh**: it may perform `lookup_invoice`, but callers are not promised a fresh wallet round trip on every HTTP request.

### 8.3 Recovery path — the background sweep (catches abandoned invoices)

A separate sweep finds invoices nobody is actively polling (paid-then-tab-closed). It is **decoupled from request cadence**, **store-throttled**, **async/non-blocking**, and **hard-bounded**:

```
maybeSweep(now):                                    // called from OpenReceive routes (after responding) + boot
  m = getMeta("last_sweep_at")                      // ONE cheap read on the hot path
  if m and now - m.value < SWEEP_INTERVAL_SEC: return            // throttled (store-based, multi-worker-safe)
  if casMeta("last_sweep_at", now, m?.rev ?? null).status != "ok": return   // only the CAS winner sweeps
  // run async (never blocks the triggering request; serverless: ctx.waitUntil):
  records = store.listOpen({ now, limit: SWEEP_BATCH })          // HARD-bounded scan
  for rec in records: gatedLookup(rec, now)                      // each lookup still gated (cooldown + bucket)
```

Guarantees and guard-rails:

- **No per-request latency blowup:** the hot path adds one `getMeta` read; the scan runs at most once per `SWEEP_INTERVAL_SEC` _globally_ (CAS winner only) and executes **after** the request is answered.
- **Bounded work:** `listOpen({ limit: SWEEP_BATCH })`; remaining due invoices are picked up by subsequent sweeps. `listOpen` returns only non-terminal rows (open invoices expire within minutes and drop out), so the set is small.
- **No surprises:** only OpenReceive's own routes carry `maybeSweep` — never arbitrary app middleware or health checks.
- **Interactive priority:** interactive lookups and the sweep share the token bucket; keeping the sweep throttled + batched prevents it starving waiting customers of tokens. (A token reservation/priority lane for interactive lookups is noted as a future refinement if a high-volume merchant needs it.)
- **In-memory throttle is gone:** `last_sweep_at` lives in the store, so the throttle is correct across Puma/Unicorn/Node-cluster/replica processes.

### 8.4 Optional scheduled ping (hard-timing upgrade, not a daemon)

For **low-traffic + high-value + must-ship-without-a-visitor** stores, add one scheduled trigger that hits the protected `/openreceive/v1/poll` route (which calls `maybeSweep`). It is **not** a worker — the platform's clock invokes a stateless function for ~one second. Per host (`*/2 * * * *` = every 2 min):

- **Vercel** — `vercel.json`: `{ "crons": [{ "path": "/api/openreceive/poll", "schedule": "*/2 * * * *" }] }`
- **Netlify** — function: `export const config = { schedule: "*/2 * * * *" };`
- **Cloudflare Workers** — `wrangler.toml`: `[triggers]` / `crons = ["*/2 * * * *"]` (or a DO alarm that reschedules itself)
- **Plain server / Hetzner** — `crontab`: `*/2 * * * * curl -s -H "Authorization: Bearer $OPENRECEIVE_CRON_SECRET" https://yoursite.com/openreceive/v1/poll`
- **GitHub Actions** — `on: schedule: - cron: "*/2 * * * *"`

Protect the endpoint (platform crons → internal-only; curl/Actions → check `OPENRECEIVE_CRON_SECRET`). `npx openreceive poll --once` is the CLI form (Cloud Run Job, cron container) — a **one-shot sweep**, not a loop.

### 8.5 Honest gaps

- **Idle app:** if no request reaches any worker for a long stretch, the sweep doesn't run until the next request or a **boot** (boot triggers a sweep, catching up after downtime). Correctness unaffected; the optional cron closes it.
- **Burst:** under a flood of simultaneous payments, lookups are paced by the bucket → discovery spread over seconds/minutes, not instant. Correct and at-least-once; the trade for never overloading the wallet.

### 8.6 Why this is safe

Every trigger is a _prompt to check the wallet_; the **wallet is the source of truth**, the durable record is the books. Late/missed/duplicate triggers affect only latency, never correctness. All coordination (idempotency precedence, both lookup gates, the action lease, the sweep throttle) lives in the one durable store every worker shares — which is exactly why there is no in-memory state.

---

## 9. Namespacing + multi-instance

`OPENRECEIVE_NAMESPACE` (default `default`), `^[a-z0-9_]{1,40}$`.

| Transport  | Namespace becomes                                                                                                    |
| ---------- | -------------------------------------------------------------------------------------------------------------------- |
| Postgres   | a schema (`CREATE SCHEMA IF NOT EXISTS <ns>; SET search_path`) **or** prefix `<ns>_openreceive_*` (schema preferred) |
| MySQL      | table prefix `<ns>_openreceive_*`                                                                                    |
| SQLite     | one DB file per namespace (`local-sqlite` → `./.openreceive/<ns>.sqlite3`)                                           |
| Redis / DO | key prefix `<ns>/…`                                                                                                  |

Two layers, documented explicitly:

- **Namespace = operational isolation** (different apps, staging vs prod, clean teardown). One token, every transport, including the per-namespace `lookup_bucket` and `last_sweep_at`.
- **`merchant_scope` = logical isolation within an instance** (already part of the idempotency key). Tenants sharing a namespace can't collide on idempotency but **do** share the sweep and bucket — so staging and prod use **different namespaces**.

---

## 10. Boot sequence — ownership-guarded, not "refuse if exists"

The requirement is _don't adopt or overwrite a table that isn't ours_ — an **ownership** check, not "create only if absent, else refuse" (which would crash every restart after the first boot, stranding pending invoices). Using `getMeta`/`casMeta`:

`_meta` rows written once on first boot: `owner="openreceive"`, `schema_version="v0.1"`, `namespace="<ns>"`, `created_at`, `lookup_bucket={tokens:MAX,refilled_at:now}`.

```
ensureSchema():
  1. CREATE TABLE IF NOT EXISTS <ns>_openreceive_meta (…);          // idempotent, safe every boot
  2. owner = getMeta("owner")
  3. if invoices table exists AND (owner missing OR owner.value != "openreceive"):
         REFUSE: "A table named <ns>_openreceive_invoices exists and was not created by OpenReceive.
                  Set OPENRECEIVE_NAMESPACE to a unique value."
  4. if getMeta("schema_version") > THIS_PACKAGE_VERSION: REFUSE  // newer store than this build
  5. CREATE TABLE IF NOT EXISTS <ns>_openreceive_invoices (…);     // idempotent
  6. casMeta("owner","openreceive",null); … ; casMeta("lookup_bucket", …, null);   // claim, once
  7. proceed (normal restart path → NO error)
```

For Redis/DO (no "table exists" notion) the ownership marker **is** the guard: `casMeta("owner","openreceive",null)` doubles as "claim this namespace"; a mismatch refuses startup. Refuse **only** on (3) a foreign same-named table or (4) a newer schema.

---

## 11. Configuration surface

```bash
# pick exactly ONE store:
OPENRECEIVE_STORE=postgres://user:pass@host:5432/appdb     # same DB as the app is fine
OPENRECEIVE_STORE=mysql://user:pass@host:3306/appdb
OPENRECEIVE_STORE=sqlite:///abs/path/openreceive.sqlite3   # explicit single-machine file
OPENRECEIVE_STORE=local-sqlite                              # convenience: gitignored ./.openreceive/<ns>.sqlite3
OPENRECEIVE_STORE=redis://…                                 # optional
OPENRECEIVE_STORE=memory:                                   # tests / throwaway demos only
# Cloudflare et al.: no env var — a Durable Object binding wired in wrangler config.

OPENRECEIVE_NAMESPACE=acme_prod                            # default: "default"
OPENRECEIVE_NWC=nostr+walletconnect://...                  # the only mandatory secret
OPENRECEIVE_CRON_SECRET=…                                  # only if you add the optional scheduled ping
# Optional tuning (sane defaults shipped):
OPENRECEIVE_LOOKUP_BURST=8           OPENRECEIVE_LOOKUP_RATE_PER_SEC=4
OPENRECEIVE_ACTION_LEASE_TTL_SEC=60
OPENRECEIVE_SWEEP_INTERVAL_SEC=20    OPENRECEIVE_SWEEP_BATCH=200
```

Scheme → adapter in `@openreceive/node`: `resolveOpenReceiveStore(uri, { namespace })`.

**`local-sqlite` (single-machine self-hosting):** creates a gitignored `./.openreceive/` folder and a per-namespace file `./.openreceive/<namespace>.sqlite3`; `openreceive init` adds `.openreceive/` to `.gitignore`. The adapter **refuses on ephemeral/serverless runtimes** and warns it is single-host only (no shared filesystem across machines; file vanishes on redeploy on ephemeral hosts). Multi-host requires Postgres/MySQL/Redis/DO. `OPENRECEIVE_STORE` and `OPENRECEIVE_CRON_SECRET` are server-only secrets alongside `OPENRECEIVE_NWC`.

---

## 12. CLI changes (`packages/js/node/src/cli.ts`)

| Command   | Today                                                 | After                                                                                                                                                                            |
| --------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`    | scaffolds config/env/worker stubs                     | scaffolds config/env for the worker-free baseline; **adds `.openreceive/` to `.gitignore`** for `local-sqlite`; no worker stub                                                   |
| `migrate` | **required** hand-run step                            | **optional**; alias for `ensureSchema()` + `--print` to emit DDL                                                                                                                 |
| `doctor`  | inspects 20 columns / 2 index names / 16 method names | **live round-trip**: connect → `putIfAbsent` rejects a duplicate (and reports the right `on`) → `casMeta` CAS works → `listOpen({limit})` → ownership/version OK → NWC preflight |
| `poll`    | settlement polling runner (loop)                      | **`poll --once` only** — a one-shot sweep for an optional scheduler                                                                                                              |
| `worker`  | poll + listen daemon                                  | **removed**                                                                                                                                                                      |
| `listen`  | NWC notification listener                             | **removed**                                                                                                                                                                      |

New flags: `--store <uri>`, `--namespace <ns>`. `--postgres`/`--sqlite`/`--database-url` removed. Drop the `REQUIRED_*` checks.

---

## 13. File-by-file change list

### `packages/js/core`

- `src/storage/index.ts` — keep `InvoiceStorageRow` (add `last_lookup_at?`, `action_claimed_at?`), `validateInvoiceStorageRow`, `canonicalJson`, `createIdempotencyRequestHash`, `idempotencyScopeKey`, error classes. **Delete `OpenReceiveInvoiceStore` (16-method) and `InMemoryInvoiceStore`.**
- `src/storage/kv.ts` — **new**: `OpenReceiveInvoiceKvStore` (9 methods, typed `putIfAbsent` result), `StoredRecord`, `MetaRow`.
- `src/storage/memory-kv.ts` — **new**: `InMemoryInvoiceKvStore` (tests/dev).
- `src/state/transitions.ts` — **new**: the `apply*` / `markLookupAttempted` / `claimSettlementAction` / `clearSettlementActionClaim` functions.
- `src/runner/reconcile.ts` — **new**: `gatedLookup`, `tryConsumeLookupToken`, `cooldownFor(age)`, `maybeSweep` (store-throttled, bounded, async), `runSettlementAction` (lease).
- `src/runner/index.ts` — rewrite to call core transitions + store directly; **delete the always-on interval/`start()` loop.** Keep `reconcileOnce` for `/poll` and `poll --once`.
- `src/index.ts` — export KV types, transitions, `gatedLookup`, `maybeSweep`.

### `packages/js/node`

- `src/postgres-store.ts`, `src/sqlite-store.ts` — **rewrite** as ~120-line KV adapters (control-columns+blob + `_meta`); `ensureSchema()` with ownership/version; SQLite WAL + `local-sqlite` folder logic + ephemeral-runtime refusal.
- `src/mysql-store.ts`, `src/redis-store.ts` — **new** transports.
- ~~`src/s3-store.ts`~~ — **not built** (S3 deferred).
- `src/store-uri.ts` — **new**: `resolveOpenReceiveStore` (incl. `local-sqlite`).
- `src/storage-schema.ts` — schema version for the `_meta` check.
- `migrations/001_*.postgres.sql` — **replace** with the control-columns table + `_meta`; retained only as `--print` output.
- `src/cli.ts` — per §12.
- `src/listener.ts` — **delete**.

### `packages/js/express`, `packages/js/next`

- `src/index.ts` — `mountOpenReceiveExpressRoutes` / `createOpenReceiveFetchHandler` / `createOpenReceiveNodeHandler` / Next `dispatchOpenReceiveNextRoute`: the lookup route calls `gatedLookup` on the single requested invoice; all routes call `maybeSweep` **after responding** (`ctx.waitUntil` on serverless); expose protected `/openreceive/v1/poll`. **Delete `createOpenReceiveExpressSettlementPollingRunner` and the in-memory SSE event bus (`express/src/index.ts:252`).** SSE, if reintroduced later, must be an explicitly opt-in cross-process transport — never an in-memory bus (which silently fails across workers).

### `packages/js/browser`, `react`, `elements`, `svelte`, `vue`, `angular`, `provider-data`

- **Browser polling is the single authoritative UI recovery path** (`browser/src/index.ts:2905`, 3s default). Remove any SSE/event-bus client wiring. Document the gated-lookup behavior (young invoice → responsive; old → rare). Copy updates only.

### `packages/ruby/openreceive`, `packages/ruby/openreceive-rails`

- `openreceive-rails` — **delete the ActiveRecord model + `create_openreceive_tables.rb` migration**, the listener/worker job, and any in-memory broadcast. Use the URI-named, OpenReceive-owned store via `pg`/`sqlite3` directly. Generator keeps controller + route templates + protected `/poll`; the lookup action calls `gatedLookup`, other actions call `maybeSweep` after responding.
- `openreceive` (ruby core) — add the KV contract + transitions + `gatedLookup`/`maybeSweep` + action lease + transport adapters mirroring JS, sharing spec vectors.

### `spec/`

- `schemas/` — `StoredRecord`, `MetaRow`, `lookup_bucket` value, `last_sweep_at` value; `InvoiceStorageRow` gains `last_lookup_at?`, `action_claimed_at?`; typed `putIfAbsent` result.
- `test-vectors/` — **add** the transport-agnostic suite (§15).
- `openapi/` — keep the core HTTP contract (lookup by `payment_hash` **or** `invoice`) but document lookup as a **gated status refresh**, add protected `/poll`, and remove `/events` from the default contract or mark it optional/experimental behind a cross-process event transport.
- `asyncapi/` — no default event stream contract after SSE removal. If events return later, AsyncAPI is an optional extension for a real cross-process transport, never the in-memory bus.

### `tools/`

- `validation`/`conformance` — run the suite against memory, postgres, mysql, sqlite, redis, DO harness. **No S3.**
- `package-smoke` — boot each adapter twice (assert `ensureSchema` idempotency, no error); ownership refusal on a planted foreign table; `local-sqlite` folder/gitignore creation.
- `live-wallet smoke` — unchanged (skips without `OPENRECEIVE_NWC`).

### `docs/`

- `16-supported-databases.md` — **rewrite** around transports + `OPENRECEIVE_STORE`; "supported = passes the suite + live smoke"; SQLite single-machine/WAL + `local-sqlite` + ephemeral warning; CF DO-not-Workers-KV; **S3 explicitly listed as deferred/unsupported in v1**.
- `01-quickstart-node.md` / `02-quickstart-rails.md` / `03-quickstart-python.md` / `04-quickstart-php.md` — lead with install, set `OPENRECEIVE_STORE` + `OPENRECEIVE_NWC`, mount routes, **done — no worker, no listener, no migrate**; remove ORM-model/migration steps; document the idempotent-hook requirement.
- `05-frontend-checkout.md` — browser polling is the UI recovery path; remove SSE guidance (or mark opt-in/experimental).
- `17-background-workers.md` — **rewrite** as "Recovery & settlement (no worker, poll-only)": the §8 paths, the two gates, the sweep throttle + async bounds, the action lease + idempotent hooks, the optional cron snippets, the idle/burst gaps.
- `07-nwc-client-strategy.md` — settlement is poll-only; cooldown curve + token bucket implement the NWC cadence/rate limits.
- `10-security.md`, `14-secret-management.md` — `OPENRECEIVE_STORE` / `OPENRECEIVE_CRON_SECRET` server-only.
- `api-reference.md`, `sdk-status.md`, `manifest.json` — store language; transport matrix (no S3); `/poll`; remove listener/worker/SSE references; document at-least-once hooks.
- new `docs/18-storage-and-namespaces.md` — URI scheme table, `local-sqlite`, namespace vs `merchant_scope`, ownership-guard boot, tuning.

### `or-master-plan.txt` and `docs/adr/` — see §16.

### `examples/hello-fruit/*`, `demos/deploy/*`

- JS demos: `OPENRECEIVE_STORE=local-sqlite` (or `postgres://`/`memory:`); remove the explicit migrate step; run **without a worker, listener, or SSE**; idempotent `markOrderPaid` keyed on `payment_hash`; add a commented optional cron. Rails demo: drop the ActiveRecord migration; use the owned store.

---

## 14. What the framework packages become (the breadth payoff)

Store adapters are keyed by **transport** (postgres, mysql, sqlite, redis, DO) — ~5 total, shared across all frameworks. A framework package = **route adapter (gated lookup + `maybeSweep` + `/poll`) + optional one-shot poll entrypoint**. Rails sets `OPENRECEIVE_STORE` (often its own `DATABASE_URL`) and OpenReceive talks to Postgres via `pg` directly — not ActiveRecord. A new language wraps the same transport contract with its standard drivers, reusing the spec vectors. No per-framework migrations, ORM models, worker, listener, or SSE bus.

---

## 15. Conformance — the new "supported backend" bar

One transport-agnostic suite (in `spec/test-vectors/`) every adapter must pass, plus a per-transport live smoke. (Adapters: memory, postgres, mysql, sqlite, redis, DO. **No S3.**)

1. `putIfAbsent` atomic under concurrency: N parallel creators of the same `invoice_id` → exactly one `created`; **and the conflict result names the correct `on` key** for `invoice_id`, `idempotency_scope`, `payment_hash`, and `bolt11` collisions.
2. Create-sequence precedence: same scope + same request hash → REPLAY; same scope + different hash → 409 idempotency-conflict; distinct logical invoices can never share `payment_hash`/`bolt11`.
3. `put` rejects stale `rev` (`conflict`), accepts current (`ok`).
4. `casMeta` atomic under concurrency: N parallel CAS on one key → exactly one `ok` per `rev`.
5. **Concurrent create tradeoff:** N concurrent identical creates may call `make_invoice` more than once, but exactly one invoice is stored/returned for the idempotency scope; losers replay the winner when request hashes match. Extra wallet invoices are not stored, cannot fulfill, and expire.
6. `listOpen` returns exactly the non-terminal set, honors `limit`; terminalized rows disappear.
7. Secondary indexes (`ph`, `b11`, `idem`) consistent across create/transition; Redis/DO prove primary + secondary reservations are atomic. `repairIndexes` may rebuild stale indexes but is never required for uniqueness correctness.
8. Ownership guard: planted foreign same-named table → boot refuses; our own table on second boot → no error; newer `schema_version` → refuses.
9. **Per-invoice lookup claim:** concurrent gated lookups across simulated processes → **at most one `lookup_invoice` per invoice per cooldown window**.
10. **Global token bucket:** N concurrent passes, M due invoices, bucket size K → **total `lookup_invoice` in a burst window ≤ K**, then refill-rate.
11. **Sweep throttle:** N concurrent `maybeSweep` across simulated processes → the scan runs **at most once per `SWEEP_INTERVAL_SEC`**, and never exceeds `SWEEP_BATCH` lookups per run.
12. **Action lease:** concurrent `runSettlementAction` across simulated processes → **at most one hook execution per non-crash window**; a claim whose worker "crashes" (never completes) is **re-claimed after `ACTION_LEASE_TTL`** and re-run (proving at-least-once + recovery, and why hooks must be idempotent).

A backend is **certified** iff it passes (1)–(12) + a live round-trip.

---

## 16. Master plan + ADR edits

### `or-master-plan.txt`

- **"Persistence ownership"** — rewrite to OpenReceive-owned store via standard per-language drivers (never the app's ORM), one frozen opaque-blob keyspace, `OPENRECEIVE_STORE` URI, namespace, ownership-guarded boot; apps keep their own tables and connect via metadata + the (idempotent) settlement hook.
- **"Required invoice row fields"** — keep logical fields (add `last_lookup_at`, `action_claimed_at`); state they live in the opaque `data` blob, validated in core.
- **Worker/listener/"required backend package API shape"** — **delete the worker and listener model.** Replace with poll-only settlement; two paths (interactive gated lookup + store-throttled async sweep); two store-enforced lookup gates; the at-least-once action lease; no daemon/listener/in-memory state; optional one-shot `/poll`.
- **Supported databases** — Postgres, MySQL, SQLite (single machine), Redis (optional), Cloudflare DO. S3 deferred.

### `docs/adr/`

- **ADR-0003 (idempotency/storage invariants)** — amend: enforced by atomic `putIfAbsent`; **precedence rule explicit** (idempotency scope decided first → replay-or-409; retryable `invoice_id` collision second; payment_hash/bolt11 third → storage-conflict); the typed `putIfAbsent` result; the create sequence; and the accepted rare abandoned-invoice tradeoff under concurrent identical creates.
- **New ADR-0005 — Self-owned KV persistence + URI configuration** (9-method contract, own connection, opaque-blob frozen schema, URI/namespace, ownership boot, transports incl. `local-sqlite`, S3 deferred).
- **New ADR-0006 — Poll-only, worker-free, store-coordinated recovery** (no listener/webhook/in-memory state; interactive gated lookup vs store-throttled async sweep; the two gates; the idle/burst gaps; optional `/poll`).
- **New ADR-0007 — At-least-once settlement actions** (CAS lease eliminates concurrent duplicates + recovers crashes but not crash-after-hook; hooks MUST be idempotent, deduped by `payment_hash`).
- **ADR-0002 (no frontend NWC)** — reaffirm `OPENRECEIVE_STORE`, `OPENRECEIVE_NWC`, `OPENRECEIVE_CRON_SECRET` server-only.

---

## 17. What is lost — honest tradeoffs

1. **No push-based settlement.** Poll-only: instant for the customer on the page (browser polls), trigger-latency after the tab closes.
2. **At-least-once, not exactly-once.** A crash after the hook runs but before completion replays the external effect; the lease only removes _concurrent_ duplicates and recovers crashed claims. **Hooks must be idempotent.** This is the Stripe-webhook contract.
3. **No cross-store atomicity with the app's order row.** Mitigated by `payment_hash` idempotency + the lease + the sweep; a crash between OpenReceive's record and the app's effect is self-healing (and the idempotent hook makes the replay harmless).
4. **No S3/object storage in v1.** Atomic uniqueness across four separate objects is a reservation/recovery protocol, deferred until SQL/Redis/DO are proven. `local-sqlite` covers the "no database, one box" case; DO covers serverless.
5. **`local-sqlite` is single-machine only.** No shared filesystem across machines; gone on ephemeral hosts. Multi-host → Postgres/MySQL/Redis/DO.
6. **Opaque blobs are weaker for ad-hoc SQL analytics.** On SQL you still query JSON; merchants project into their own tables from the hook for dashboards.
7. **Idle-app + burst discovery latency** (§8.5). Correctness unaffected; the optional cron closes the idle gap; the bucket paces the burst.

---

## 18. Phased rollout

- **Phase 1 — Core.** Add the 9-method KV contract (typed `putIfAbsent`), `StoredRecord`/`MetaRow`, `InMemoryInvoiceKvStore`, the `apply*`/claim transitions, `gatedLookup` + the two gates, `maybeSweep` (throttle + bounds), `runSettlementAction` (lease). **Delete** the 16-method store + `InMemoryInvoiceStore` + the always-on loop. Port core tests.
- **Phase 2 — SQL backends + config.** Rewrite Postgres + SQLite as KV adapters (incl. `local-sqlite`, WAL, ephemeral refusal); `ensureSchema()` + ownership/version; `resolveOpenReceiveStore`; `migrate` optional; `doctor` round-trip; delete `listener.ts`.
- **Phase 3 — Namespacing + ownership boot.** `OPENRECEIVE_NAMESPACE` across transports; planted-foreign-table refusal; per-namespace bucket + sweep clock.
- **Phase 4 — Route-driven recovery + remove SSE.** Express/Next/Rails: gated lookup endpoint, `maybeSweep` after responding, protected `/poll`; **delete the in-memory SSE event bus and all event-bus client wiring**; browser polling becomes the sole UI path; rewrite `17-background-workers.md`; document idempotent hooks.
- **Phase 5 — New transports.** Redis/Upstash + Cloudflare Durable Object storage — each ~120 lines + green suite (incl. vectors 9–12, plus atomic index reservation).
- **Phase 6 — De-couple frameworks + rewrite doctrine.** Drop Rails ActiveRecord model/migration; framework packages = route adapter + optional one-shot poll. Rewrite master-plan persistence + worker sections; add ADR-0005/0006/0007; amend ADR-0003. Update quickstarts, demos, `manifest.json`, `sdk-status.md`.

---

## 19. Developer experience — before vs after

**Before (Node, today):**

```sh
npm install @openreceive/node @openreceive/express @openreceive/browser express pg
npx openreceive migrate --postgres "$DATABASE_URL"     # hand-run, per-DB
npx openreceive doctor  --postgres "$DATABASE_URL"
# write server/openreceive.ts wiring a Postgres store
# deploy web PLUS a separate openreceive-worker process (poll + listen daemon)
```

**After:**

```sh
npm install @openreceive/node @openreceive/express @openreceive/browser express
# .env:
#   OPENRECEIVE_NWC=nostr+walletconnect://...
#   OPENRECEIVE_STORE=local-sqlite           # or postgres:// / mysql:// / a CF binding
#   OPENRECEIVE_NAMESPACE=myapp_prod          # optional
mountOpenReceiveExpressRoutes(app, openreceive);   // self-initializes on boot
# openreceive init adds .openreceive/ to .gitignore when using local-sqlite
# settlementAction MUST be idempotent, e.g. UPDATE orders SET paid=true WHERE id=? AND paid=false
# deploy web. No worker. No listener. No migrate.
# Recovery: interactive gated lookups + a store-throttled async sweep on requests/boot.
# Add one cron line only if low-traffic + high-value orders must ship with no visitor.
```

Rails after: set `OPENRECEIVE_STORE` (often the app's own `DATABASE_URL`), mount routes — **no ActiveRecord model, no `create_openreceive_tables` migration, no worker, no listener, no SSE bus.** Make the settlement effect idempotent on `payment_hash`.

---

_End of plan (v2)._
