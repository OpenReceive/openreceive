// The executable model of the payment-attempt state machine (AGENTS.md
// "Non-negotiables"): pure JavaScript with no engine imports, so it can never
// inherit a bug from the code it checks. Given a sequence of operations it
// predicts, step by step, every row's status, status_reason and paid_at, the
// fulfillment ledger and each operation's outcome.
//
// generate.mjs turns random operation sequences into
// spec/test-vectors/attempt-state-machine.json; each engine replays that file
// through its real repository, reconciler and notification path, and checks the
// same invariants after every step.
//
// A rule change here must change the vectors in the same commit; the JS replay
// test regenerates the file and fails on any difference.

export const GRACE_SECONDS = 900;
export const REUSE_BUFFER_SECONDS = 60;
/**
 * Scans in a sequence are at least this far apart, so the durable reconcile gate
 * (12 s at most) and its lease (10 s) are always open. The gate has its own vectors
 * (reconcile-progress); here a scan op means a pass ran.
 */
export const MIN_SCAN_GAP_SECONDS = 15;
export const BASE_TIME = 1_000_000;
export const LIGHTNING = "ln";
export const SWAP_ASSETS = ["USDT_TRON", "USDC_ETH"];
export const STATUSES = ["pending", "settled", "expired", "failed", "attention"];
export const WALLET_STATES = [
  "absent",
  "stateless",
  "pending",
  "accepted",
  "failed",
  "expired",
  "settled_at",
  "settled_state",
  "settled_full",
];
export const SCAN_MODES = [
  "ok",
  "fail",
  "unrecognized_key",
  "unrecognized_type",
  "unusable_rows",
  "fail_after_1",
  "fail_after_2",
];
export const NOTIFICATION_FINALITIES = ["settled_at", "state", "preimage", "none", "absent"];

const PAGE_SIZE = 20;
const SCAN_OVERLAP_SECONDS = 60;
const SETTLED_WALLET_STATES = new Set(["settled_at", "settled_state", "settled_full"]);

/** Raised when an operation is meaningless at its position (the shrinker drops such candidates). */
export class InvalidSequence extends Error {}

export function newState(start = BASE_TIME) {
  return {
    now: start,
    lastPassAt: null,
    attempts: new Map(),
    wallet: new Map(),
    fulfilled: [],
  };
}

const failAfterCalls = (mode) => (mode.startsWith("fail_after_") ? Number(mode.slice(11)) : null);

function isLive(attempt, now) {
  return (
    attempt.status === "pending" && attempt.rowExpiresAt > now && attempt.reason !== "superseded"
  );
}

function referenceAttempts(state, ref) {
  return [...state.attempts.values()].filter((attempt) => attempt.ref === ref);
}

function hasSettled(state, ref) {
  return referenceAttempts(state, ref).some((attempt) => attempt.status === "settled");
}

function liveOnRail(state, ref, rail) {
  return referenceAttempts(state, ref).find(
    (attempt) => attempt.rail === rail && isLive(attempt, state.now),
  );
}

/** Settlement write-once: first settled attempt on the reference fulfills, inside the same transaction. */
function settle(state, attempt, paidAt, failFulfillment) {
  if (attempt.status !== "pending") return false;
  const first = !hasSettled(state, attempt.ref);
  if (first && failFulfillment) return false; // the host's hook raised: the transaction rolled back
  attempt.status = "settled";
  attempt.reason = first ? null : "duplicate_settlement";
  attempt.paidAt = paidAt;
  if (first) state.fulfilled.push([attempt.ref, attempt.id]);
  return true;
}

function closeAttempt(attempt, status, reason) {
  attempt.status = status;
  attempt.reason = reason;
}

/** The attempt-reconciliation decision table: terminal wallet reports close now, everything else needs expiry + grace. */
function applyTransition(attempt, scanStatus, transactionState, now) {
  if (scanStatus === "failed") return closeAttempt(attempt, "failed", "wallet_reported_failed");
  if (scanStatus === "expired") return closeAttempt(attempt, "expired", "wallet_reported_expired");
  if (now < attempt.walletExpiresAt + GRACE_SECONDS) return undefined;
  if (scanStatus === "not_found") return closeAttempt(attempt, "expired", "not_found_after_expiry");
  if (transactionState === "pending" || transactionState === "accepted") {
    return closeAttempt(attempt, "attention", "unsettled_after_expiry");
  }
  return closeAttempt(attempt, "expired", "no_finality_after_expiry");
}

function classifyWalletRow(row) {
  if (SETTLED_WALLET_STATES.has(row.state)) return "settled";
  if (row.state === "failed" || row.state === "expired") return row.state;
  return "pending";
}

/** The wallet's listing: newest first, deterministically, as the fake wallet in every engine serves it. */
function walletListing(state, window, unpaid) {
  return [...state.wallet.entries()]
    .map(([id, row]) => ({ id, ...row }))
    .filter((row) => row.createdAt >= window.from && row.createdAt <= window.until)
    .filter((row) => unpaid || SETTLED_WALLET_STATES.has(row.state))
    .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
}

/**
 * One reconcile pass, mirroring the walk every engine shares (spec:
 * wallet-scan-truncation, reconcile-progress): a default-view walk (settled
 * rows), then an inclusive walk for unpaid rows, each ending on an empty page
 * or once every expected hash has been seen. Settlements found on a page
 * commit as they are found; closures are decided only by a walk that completes.
 */
function runPass(state, mode, failFulfillment) {
  state.lastPassAt = state.now;
  const pending = [...state.attempts.values()].filter((attempt) => attempt.status === "pending");
  if (pending.length === 0) return "no_pending";
  if (
    mode === "fail" ||
    mode === "unrecognized_key" ||
    mode === "unrecognized_type" ||
    mode === "unusable_rows"
  ) {
    return "scan_failed";
  }
  const limit = failAfterCalls(mode);
  const expected = new Map(pending.map((attempt) => [attempt.id, attempt]));
  const created = pending.map((attempt) => attempt.createdAt);
  const window = {
    from: Math.max(0, Math.min(...created) - SCAN_OVERLAP_SECONDS),
    until: Math.max(...created) + SCAN_OVERLAP_SECONDS,
  };
  const seen = new Set();
  const observations = new Map();
  const finality = new Map();
  let calls = 0;
  let failed = false;
  const allSeen = () => [...expected.keys()].every((id) => seen.has(id));
  walk: for (const view of ["default", "inclusive"]) {
    let offset = 0;
    for (;;) {
      if (limit !== null && calls >= limit) {
        failed = true;
        break walk;
      }
      calls += 1;
      const rows = walletListing(state, window, view === "inclusive").slice(
        offset,
        offset + PAGE_SIZE,
      );
      for (const row of rows) {
        const attempt = expected.get(row.id);
        if (attempt === undefined) continue;
        const status = classifyWalletRow(row);
        seen.add(row.id);
        if (status === "settled") {
          if (finality.get(row.id) !== "settled") {
            settle(state, attempt, row.settledAt ?? state.now, failFulfillment);
            finality.set(row.id, "settled");
          }
        } else if (status === "failed" || status === "expired") {
          if (!finality.has(row.id)) finality.set(row.id, status);
        } else if (!finality.has(row.id)) {
          observations.set(row.id, row.state);
        }
      }
      if (allSeen()) break walk;
      if (rows.length === 0) {
        if (view === "default") break; // on to the inclusive walk
        break walk;
      }
      offset += rows.length;
    }
  }
  if (failed) return "scan_failed";
  for (const attempt of pending) {
    if (attempt.status !== "pending") continue;
    const final = finality.get(attempt.id);
    if (final === "settled") continue; // fulfillment failed: the row retries next pass
    if (final !== undefined) {
      applyTransition(attempt, final, undefined, state.now);
    } else if (observations.has(attempt.id)) {
      const walletState = observations.get(attempt.id);
      const transactionState =
        walletState === "pending" || walletState === "accepted" ? walletState : undefined;
      applyTransition(attempt, "pending", transactionState, state.now);
    } else {
      applyTransition(attempt, "not_found", undefined, state.now);
    }
  }
  return "ran";
}

function setWalletRow(state, id, kind, settledAt, createdAt) {
  if (kind === "absent") {
    state.wallet.delete(id);
    return;
  }
  const existing = state.wallet.get(id);
  state.wallet.set(id, {
    createdAt: existing?.createdAt ?? createdAt,
    state: kind,
    settledAt: kind === "settled_at" || kind === "settled_full" ? settledAt : undefined,
  });
}

/** The checkout an operation would commit: a row created earlier in the wallet keeps its created_at. */
function commitPayload(state, op) {
  const createdAt = state.wallet.get(op.id)?.createdAt ?? state.now;
  const walletExpiresAt = createdAt + op.expires_in;
  const depositExpiresAt = op.rail === LIGHTNING ? undefined : createdAt + op.deposit_in;
  return {
    created_at: createdAt,
    expires_at: walletExpiresAt,
    ...(depositExpiresAt === undefined ? {} : { deposit_expires_at: depositExpiresAt }),
  };
}

function insertAttempt(state, op, payload) {
  state.attempts.set(op.id, {
    id: op.id,
    ref: op.ref,
    rail: op.rail,
    createdAt: payload.created_at,
    walletExpiresAt: payload.expires_at,
    rowExpiresAt: payload.deposit_expires_at ?? payload.expires_at,
    status: "pending",
    reason: null,
    paidAt: null,
  });
}

function createOutcome(state, op) {
  if (hasSettled(state, op.ref)) return { outcome: "already_paid" };
  const live = liveOnRail(state, op.ref, op.rail);
  if (live !== undefined && live.rowExpiresAt - state.now > REUSE_BUFFER_SECONDS) {
    return { outcome: "reused", reused_id: live.id };
  }
  if (live !== undefined) live.reason = "superseded";
  const payload = commitPayload(state, op);
  insertAttempt(state, op, payload);
  return { outcome: "inserted", ...payload };
}

function commitOutcome(state, op) {
  const payload = commitPayload(state, op);
  const existing = state.attempts.get(op.id);
  if (existing !== undefined) {
    return { outcome: existing.ref === op.ref ? "idempotent" : "conflict", ...payload };
  }
  if (hasSettled(state, op.ref)) return { outcome: "conflict", ...payload };
  const live = liveOnRail(state, op.ref, op.rail);
  if (live !== undefined) {
    if (live.rowExpiresAt - state.now > REUSE_BUFFER_SECONDS) {
      return { outcome: "conflict", ...payload };
    }
    // Marked, not closed: the row stays pending so the wallet scan keeps covering it.
    live.reason = "superseded";
  }
  insertAttempt(state, op, payload);
  return { outcome: "inserted", ...payload };
}

/** A pass is always allowed to run: the clock jumps forward past the gate interval when needed. */
function openGate(state) {
  if (state.lastPassAt !== null && state.now - state.lastPassAt < MIN_SCAN_GAP_SECONDS) {
    state.now = state.lastPassAt + MIN_SCAN_GAP_SECONDS;
  }
}

function notifyWillScan(state, op) {
  if (op.kind === "sent") return false;
  const finality = op.finality === "settled_at" || op.finality === "state";
  const attempt = state.attempts.get(op.id);
  const direct = finality && attempt !== undefined && attempt.status === "pending";
  return !direct || op.fail_fulfillment === true;
}

function applyOp(state, op) {
  switch (op.op) {
    case "advance":
      state.now += op.by;
      return {};
    case "restart":
      return {};
    case "create":
      return createOutcome(state, op);
    case "commit":
      return commitOutcome(state, op);
    case "wallet": {
      const existing = state.wallet.get(op.id);
      const createdAt = existing?.createdAt ?? state.attempts.get(op.id)?.createdAt ?? state.now;
      setWalletRow(state, op.id, op.state, op.settled_at, createdAt);
      return op.state === "absent" ? {} : { created_at: createdAt };
    }
    case "notify": {
      if (op.kind === "sent") return {};
      const attempt = state.attempts.get(op.id);
      const finality = op.finality === "settled_at" || op.finality === "state";
      let walletCreatedAt;
      if (finality) {
        const existing = state.wallet.get(op.id);
        walletCreatedAt = existing?.createdAt ?? attempt?.createdAt ?? state.now;
        setWalletRow(
          state,
          op.id,
          op.finality === "settled_at" ? "settled_full" : "settled_state",
          op.settled_at,
          walletCreatedAt,
        );
      }
      const extra = walletCreatedAt === undefined ? {} : { created_at: walletCreatedAt };
      if (finality && attempt !== undefined && attempt.status === "pending") {
        const paidAt = op.finality === "settled_at" ? op.settled_at : state.now;
        if (settle(state, attempt, paidAt, op.fail_fulfillment === true)) return extra;
      }
      runPass(state, "ok", op.fail_fulfillment === true);
      return extra;
    }
    case "scan": {
      const reason = runPass(state, op.mode, op.fail_fulfillment === true);
      return op.fail_fulfillment === true ? {} : { reason };
    }
    case "replay_settlement": {
      const attempt = state.attempts.get(op.id);
      if (attempt !== undefined) settle(state, attempt, op.paid_at, op.fail_fulfillment === true);
      return {};
    }
    case "stale_close": {
      const attempt = state.attempts.get(op.id);
      if (attempt === undefined || attempt.status === "pending") {
        throw new InvalidSequence(`stale_close of ${op.id}: only a closed row is a stale write`);
      }
      return {};
    }
    default:
      throw new Error(`unknown model op: ${op.op}`);
  }
}

function rowSnapshot(state) {
  return new Map(
    [...state.attempts].map(([id, attempt]) => [
      id,
      [attempt.status, attempt.reason, attempt.paidAt],
    ]),
  );
}

/**
 * Run one operation against the model: mutates `state` and returns the step as
 * recorded in the vectors (the op plus `t`, the clock it runs at, and what must
 * be true after it: `outcome`, `reason`, the changed `rows` and any `fulfilled`
 * entries).
 */
export function stepModel(state, op) {
  if (op.op === "scan" || (op.op === "notify" && notifyWillScan(state, op))) openGate(state);
  const before = rowSnapshot(state);
  const fulfilledBefore = state.fulfilled.length;
  const result = applyOp(state, op);
  const step = { ...op, t: state.now, ...result };
  const rows = {};
  for (const [id, row] of rowSnapshot(state)) {
    const old = before.get(id);
    if (old === undefined || old.some((value, index) => value !== row[index])) rows[id] = row;
  }
  if (Object.keys(rows).length > 0) step.rows = rows;
  if (state.fulfilled.length > fulfilledBefore) {
    step.fulfilled = state.fulfilled.slice(fulfilledBefore);
  }
  return step;
}

/** Annotate a whole operation list. Throws InvalidSequence when an op is meaningless at its position. */
export function simulate(ops, start = BASE_TIME) {
  const state = newState(start);
  return ops.map((op) => stepModel(state, op));
}

/**
 * The invariants as the model itself sees them: a guard, asserted on every
 * generated step, against a broken model. Each engine runner re-checks them
 * against its real rows.
 */
export function assertModelInvariants(state) {
  const statuses = new Set(STATUSES);
  for (const attempt of state.attempts.values()) {
    if (!statuses.has(attempt.status)) throw new Error(`bad status ${attempt.status}`);
  }
  const live = new Map();
  for (const attempt of state.attempts.values()) {
    if (!isLive(attempt, state.now)) continue;
    const key = `${attempt.ref}\u0000${attempt.rail}`;
    if (live.has(key)) throw new Error(`two live attempts on ${key}`);
    live.set(key, attempt.id);
  }
  const fulfilledRefs = new Set(state.fulfilled.map(([ref]) => ref));
  if (fulfilledRefs.size !== state.fulfilled.length) {
    throw new Error("a reference was fulfilled twice");
  }
  for (const attempt of state.attempts.values()) {
    if (attempt.status === "settled" && !fulfilledRefs.has(attempt.ref)) {
      throw new Error(`settled attempt ${attempt.id} with no fulfillment`);
    }
  }
}
