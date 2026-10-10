import type { ReconcileGateClaim, ReconcileScheduler } from "./payment-repository.ts";
import { asInteger, OPENRECEIVE_RECONCILE_BATCH_SIZE } from "./payment-rows.ts";

// The durable reconcile gate over the `openreceive_meta` key/value/rev table.
// Every library repository runs this same claim and checkpoint logic; each one
// only supplies the three statement-level operations of a MetaStore, so the
// SQL and Supabase repositories cannot drift apart on the scan budget.

/** The one durable reconcile-gate row every worker shares. */
const RECONCILE_GATE_META_KEY = "transaction_scan_gate";
/** CAS retries under contention before reporting the gate busy. */
const RECONCILE_GATE_CAS_RETRIES = 6;
/**
 * Tolerance when reading a timestamp another worker wrote. Beyond it a claim
 * stamped in the future is a backwards clock step, not a fresh claim: without
 * this clamp the gate would read as busy until wall-clock time caught up.
 */
const META_CLOCK_SKEW_SECONDS = 60;

/**
 * Statement-level access to `openreceive_meta`; none of it needs a
 * transaction. Each write resolves whether it took effect, or `undefined`
 * when the store cannot tell, and the gate reads the row back instead.
 */
export interface MetaStore {
  read(key: string): Promise<{ readonly value: unknown; readonly rev: unknown } | undefined>;
  /** Insert at rev 0, doing nothing when the key already exists. */
  insertIfAbsent(key: string, value: string): Promise<boolean | undefined>;
  /** Write `value` and bump rev, only while the row is still at `rev`. */
  compareAndSet(key: string, value: string, rev: number): Promise<boolean | undefined>;
}

interface StoredGate {
  version: number;
  claimed_at: number;
  token: string;
  lease_until: number;
  interval_seconds: number;
  scheduler: ReconcileScheduler;
}
function parseGate(value: unknown): StoredGate | undefined {
  let gate: StoredGate;
  try {
    gate = JSON.parse(String(value)) as StoredGate;
  } catch {
    return undefined;
  }
  if (gate.version > 1)
    throw new TypeError(
      "A newer reconcile scheduler is installed; upgrade every application and worker together.",
    );
  // Derived legacy state can be discarded; payment rows are never altered.
  return gate.version === 1 ? gate : undefined;
}

export async function claimMetaGate(
  store: MetaStore,
  {
    now,
    intervalSeconds,
    leaseSeconds = 10,
  }: { readonly now: number; readonly intervalSeconds: number; readonly leaseSeconds?: number },
): Promise<ReconcileGateClaim | null> {
  const token = globalThis.crypto.randomUUID();
  for (let attempt = 0; attempt < RECONCILE_GATE_CAS_RETRIES; attempt += 1) {
    const current = await store.read(RECONCILE_GATE_META_KEY);
    const gate = current === undefined ? undefined : parseGate(current.value);
    if (
      gate !== undefined &&
      isFreshTimestamp(now, gate.claimed_at, Math.max(intervalSeconds, gate.interval_seconds ?? 2))
    )
      return null;
    if (
      gate !== undefined &&
      gate.claimed_at <= now + META_CLOCK_SKEW_SECONDS &&
      gate.lease_until > now
    )
      return null;
    const scheduler = gate?.scheduler ?? { cursor: null, windows: [] };
    const claimValue = JSON.stringify({
      version: 1,
      claimed_at: now,
      token,
      lease_until: now + leaseSeconds,
      interval_seconds: intervalSeconds,
      scheduler,
    });
    const wrote =
      current === undefined
        ? await store.insertIfAbsent(RECONCILE_GATE_META_KEY, claimValue)
        : await store.compareAndSet(
            RECONCILE_GATE_META_KEY,
            claimValue,
            asInteger(current.rev, "rev"),
          );
    if (wrote === true) return { token, scheduler };
    if (wrote === undefined) {
      const readback = await store.read(RECONCILE_GATE_META_KEY);
      if (readback !== undefined && String(readback.value) === claimValue)
        return { token, scheduler };
    }
  }
  return null;
}

export async function checkpointMetaGate(
  store: MetaStore,
  {
    claim,
    scheduler,
    now,
    release = false,
    intervalSeconds,
  }: {
    readonly claim: ReconcileGateClaim;
    readonly scheduler: ReconcileScheduler;
    readonly now: number;
    readonly release?: boolean;
    readonly intervalSeconds?: number;
  },
): Promise<boolean> {
  if (
    scheduler.windows.length > 2 ||
    scheduler.windows.some((window) => window.attempts.length > OPENRECEIVE_RECONCILE_BATCH_SIZE)
  )
    throw new RangeError("Reconcile progress exceeds its cohort bound.");
  const current = await store.read(RECONCILE_GATE_META_KEY);
  if (current === undefined) return false;
  const gate = parseGate(current.value);
  if (gate?.token !== claim.token || gate.lease_until <= now) return false;
  const value = JSON.stringify({
    ...gate,
    scheduler,
    lease_until: release ? 0 : gate.lease_until,
    interval_seconds: intervalSeconds ?? gate.interval_seconds,
  });
  if (new TextEncoder().encode(value).length > 131072)
    throw new RangeError("Reconcile progress exceeds 128 KiB.");
  const wrote = await store.compareAndSet(
    RECONCILE_GATE_META_KEY,
    value,
    asInteger(current.rev, "rev"),
  );
  if (wrote !== undefined) return wrote;
  const readback = await store.read(RECONCILE_GATE_META_KEY);
  return readback?.value === value;
}

/** True when `timestamp` is inside `windowSeconds` of `now`, allowing for skew. */
function isFreshTimestamp(now: number, timestamp: number, windowSeconds: number): boolean {
  const age = now - timestamp;
  // A timestamp far in the future is a clock that stepped backwards, not a
  // fresh write: clamping it to stale keeps a rewound clock from freezing the
  // gate until wall-clock time catches up.
  if (age < -META_CLOCK_SKEW_SECONDS) return false;
  return age < windowSeconds;
}
