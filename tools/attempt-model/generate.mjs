// Seeded generator of operation sequences over the attempt state machine, and
// the writer of spec/test-vectors/attempt-state-machine.json. Every sequence is
// produced by a state-aware random walk: the walk sees the model's state, so it
// keeps hitting the interesting transitions (reuse, supersede, grace boundaries,
// late payments) instead of wandering among rejected no-ops.
//
//   npm run generate:model-vectors          rewrite the vector file
//   npm run generate:model-vectors -- --check    fail when the checked-in file drifted

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertModelInvariants,
  BASE_TIME,
  GRACE_SECONDS,
  LIGHTNING,
  MIN_SCAN_GAP_SECONDS,
  newState,
  NOTIFICATION_FINALITIES,
  REUSE_BUFFER_SECONDS,
  SCAN_MODES,
  stepModel,
  SWAP_ASSETS,
} from "./model.mjs";

export const VECTOR_FILE = "spec/test-vectors/attempt-state-machine.json";
export const VECTOR_SEED = 20_261_108;
export const VECTOR_COUNT = 220;
const DEFAULT_MAX_STEPS = 18;
const EXPIRY_CHOICES = [600, 900, 1800, 3600];

/** Deterministic across runs and machines; the one source of randomness. */
export function createRng(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (low, high) => low + Math.floor(next() * (high - low + 1));
  return {
    int,
    chance: (probability) => next() < probability,
    pick: (items) => items[int(0, items.length - 1)],
    weighted: (entries) => {
      const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
      let roll = next() * total;
      for (const [item, weight] of entries) {
        roll -= weight;
        if (roll <= 0) return item;
      }
      return entries[entries.length - 1][0];
    },
  };
}

function freshAttemptOp(rng, id, ref, op = "create") {
  const rail = rng.weighted([
    [LIGHTNING, 6],
    [SWAP_ASSETS[0], 3],
    [SWAP_ASSETS[1], 2],
  ]);
  const expiresIn = rng.pick(EXPIRY_CHOICES);
  const base = { op, ref, rail, id, expires_in: expiresIn };
  if (rail === LIGHTNING) return base;
  return { ...base, deposit_in: rng.pick([120, 300, Math.max(180, expiresIn - 60)]) };
}

/** Clock jumps aimed at the boundaries the rules are written around. */
function advanceTargets(state) {
  const targets = [];
  for (const attempt of state.attempts.values()) {
    if (attempt.status !== "pending") continue;
    targets.push(
      attempt.rowExpiresAt - REUSE_BUFFER_SECONDS - 1,
      attempt.rowExpiresAt - REUSE_BUFFER_SECONDS,
      attempt.rowExpiresAt - REUSE_BUFFER_SECONDS + 1,
      attempt.rowExpiresAt - 1,
      attempt.rowExpiresAt,
      attempt.walletExpiresAt - 1,
      attempt.walletExpiresAt,
      attempt.walletExpiresAt + 1,
      attempt.walletExpiresAt + GRACE_SECONDS - 1,
      attempt.walletExpiresAt + GRACE_SECONDS,
      attempt.walletExpiresAt + GRACE_SECONDS + 1,
    );
  }
  return targets.filter((target) => target > state.now);
}

function chooseAdvance(rng, state, profile) {
  const targets = advanceTargets(state);
  if (targets.length > 0 && rng.chance(profile === "expiry" ? 0.8 : 0.55)) {
    return { op: "advance", by: rng.pick(targets) - state.now };
  }
  return { op: "advance", by: rng.int(1, 240) };
}

function randomAttemptId(rng, state) {
  const ids = [...state.attempts.keys()];
  return ids.length === 0 ? undefined : rng.pick(ids);
}

function pendingAttemptId(rng, state) {
  const ids = [...state.attempts.values()].filter((a) => a.status === "pending").map((a) => a.id);
  return ids.length === 0 ? randomAttemptId(rng, state) : rng.pick(ids);
}

function chooseWallet(rng, state, walk) {
  // A payment arriving after its attempt already closed.
  const closed = [...state.attempts.values()].filter((attempt) => attempt.status !== "pending");
  if (closed.length > 0 && rng.chance(0.3)) {
    return {
      op: "wallet",
      id: rng.pick(closed).id,
      state: "settled_full",
      settled_at: state.now - rng.int(0, 40),
    };
  }
  // Bias towards the rows a real wallet would show for an attempt just created.
  const id =
    rng.chance(0.08) && walk.announced.length > 0
      ? rng.pick(walk.announced)
      : pendingAttemptId(rng, state);
  if (id === undefined) return { op: "restart" };
  const kind = rng.weighted([
    ["stateless", 3],
    ["pending", 3],
    ["accepted", 2],
    ["failed", 2],
    ["expired", 2],
    ["settled_full", 6],
    ["settled_at", 2],
    ["settled_state", 2],
    ["absent", 1],
  ]);
  const step = { op: "wallet", id, state: kind };
  if (kind === "settled_at" || kind === "settled_full") {
    step.settled_at = state.now - rng.int(0, 40);
  }
  return step;
}

function chooseNotify(rng, state, walk) {
  const kind = rng.chance(0.08) ? "sent" : "received";
  let id;
  if (rng.chance(0.15)) {
    // Before the row exists, or a hash that never gets a row at all.
    id = walk.nextId++;
    walk.announced.push(id);
  } else {
    id = randomAttemptId(rng, state);
    if (id === undefined) {
      id = walk.nextId++;
      walk.announced.push(id);
    }
  }
  const finality = rng.weighted([
    ["settled_at", 5],
    ["state", 3],
    ["preimage", 2],
    ["none", 2],
    ["absent", 1],
  ]);
  const step = { op: "notify", id, kind, finality };
  if (finality === "settled_at") step.settled_at = state.now - rng.int(0, 40);
  return step;
}

function chooseScan(rng, state) {
  // A wallet-reported closure is only final once the walk completes; aim partial
  // failures at exactly that situation.
  const terminalInWallet = [...state.attempts.values()].some(
    (attempt) =>
      attempt.status === "pending" &&
      ["failed", "expired"].includes(state.wallet.get(attempt.id)?.state),
  );
  const mode = rng.weighted([
    ["ok", 14],
    ["fail", 3],
    ["unrecognized_key", 1],
    ["unrecognized_type", 1],
    ["unusable_rows", 1],
    ["fail_after_1", terminalInWallet ? 5 : 2],
    ["fail_after_2", terminalInWallet ? 6 : 1],
  ]);
  return { op: "scan", mode };
}

function chooseCommit(rng, state, walk) {
  // A concurrent create that passed selection, or a retried commit of a known hash.
  if (rng.chance(0.35) && state.attempts.size > 0) {
    const attempt = rng.pick([...state.attempts.values()]);
    if (rng.chance(0.25)) {
      const other = rng.pick(walk.refs.filter((ref) => ref !== attempt.ref).concat(attempt.ref));
      return {
        op: "commit",
        ref: other,
        rail: attempt.rail,
        id: attempt.id,
        expires_in: 600,
        deposit_in: 300,
      };
    }
    return {
      op: "commit",
      ref: attempt.ref,
      rail: attempt.rail,
      id: attempt.id,
      expires_in: 600,
      deposit_in: 300,
    };
  }
  const ref = rng.pick(walk.refs);
  const op = freshAttemptOp(rng, walk.takeId(state, rng), ref, "commit");
  return op;
}

const WEIGHTS = {
  default: {
    create: 16,
    wallet: 18,
    scan: 20,
    advance: 16,
    notify: 10,
    restart: 3,
    commit: 6,
    replay: 3,
    stale: 2,
  },
  expiry: {
    create: 12,
    wallet: 8,
    scan: 24,
    advance: 28,
    notify: 4,
    restart: 3,
    commit: 4,
    replay: 2,
    stale: 2,
  },
  settlement: {
    create: 16,
    wallet: 24,
    scan: 16,
    advance: 8,
    notify: 18,
    restart: 3,
    commit: 4,
    replay: 6,
    stale: 3,
  },
};

function chooseOp(rng, state, walk, profile) {
  const weights = WEIGHTS[profile];
  const closed = [...state.attempts.values()].filter((attempt) => attempt.status !== "pending");
  const kind = rng.weighted([
    ["create", state.attempts.size < 9 ? weights.create : Math.floor(weights.create / 3)],
    ["wallet", state.attempts.size > 0 || walk.announced.length > 0 ? weights.wallet : 1],
    ["scan", state.attempts.size > 0 ? weights.scan : 2],
    ["advance", weights.advance],
    ["notify", weights.notify],
    ["restart", weights.restart],
    ["commit", weights.commit],
    ["replay", state.attempts.size > 0 ? weights.replay : 0],
    ["stale", closed.length > 0 ? weights.stale : 0],
  ]);
  switch (kind) {
    case "create": {
      const id = walk.takeId(state, rng);
      return freshAttemptOp(rng, id, rng.pick(walk.refs));
    }
    case "wallet":
      return chooseWallet(rng, state, walk);
    case "scan": {
      const op = chooseScan(rng, state);
      if (rng.chance(0.1)) op.fail_fulfillment = true;
      return op;
    }
    case "advance":
      return chooseAdvance(rng, state, profile);
    case "notify": {
      const op = chooseNotify(rng, state, walk);
      if (rng.chance(0.12)) op.fail_fulfillment = true;
      return op;
    }
    case "restart":
      return { op: "restart" };
    case "commit":
      return chooseCommit(rng, state, walk);
    case "replay": {
      const id = randomAttemptId(rng, state);
      const op = { op: "replay_settlement", id, paid_at: state.now - rng.int(0, 30) };
      if (rng.chance(0.15)) op.fail_fulfillment = true;
      return op;
    }
    case "stale": {
      const target = rng.pick(closed);
      return {
        op: "stale_close",
        id: target.id,
        status: rng.pick(["expired", "failed", "attention"]),
      };
    }
    default:
      throw new Error(`unknown op kind: ${kind}`);
  }
}

export function generateOps(seed, maxSteps = DEFAULT_MAX_STEPS) {
  const rng = createRng(seed);
  const profile = rng.weighted([
    ["default", 4],
    ["expiry", 3],
    ["settlement", 3],
  ]);
  const refs = rng.pick([["r1"], ["r1"], ["r1", "r2"], ["r1", "r2", "r3"]]);
  const length = rng.int(6, maxSteps);
  const state = newState(BASE_TIME);
  const walk = {
    refs,
    announced: [],
    nextId: 1,
    takeId(currentState, random) {
      // A notification announced this hash before its row: commit it now, sometimes.
      if (this.announced.length > 0 && random.chance(0.35)) {
        const candidate = this.announced.find((id) => !currentState.attempts.has(id));
        if (candidate !== undefined) return candidate;
      }
      return this.nextId++;
    },
  };
  const ops = [];
  const emit = (op) => {
    const step = stepModel(state, op);
    assertModelInvariants(state);
    ops.push(step);
  };
  // A third of the sequences start from a shape random steps rarely reach on
  // their own: two rails live on one reference, or a live attempt about to be
  // superseded.
  const prefix = rng.int(0, 5);
  if (prefix === 0) {
    const ref = rng.pick(refs);
    const first = freshAttemptOp(rng, walk.takeId(state, rng), ref);
    emit(first);
    const secondRail = first.rail === LIGHTNING ? SWAP_ASSETS[0] : LIGHTNING;
    emit({
      op: "create",
      ref,
      rail: secondRail,
      id: walk.takeId(state, rng),
      expires_in: rng.pick(EXPIRY_CHOICES),
      ...(secondRail === LIGHTNING ? {} : { deposit_in: 300 }),
    });
  } else if (prefix === 1) {
    const first = freshAttemptOp(rng, walk.takeId(state, rng), rng.pick(refs));
    emit(first);
    const attempt = state.attempts.get(first.id);
    if (attempt !== undefined) {
      const lifeLeft = rng.int(5, REUSE_BUFFER_SECONDS);
      const by = attempt.rowExpiresAt - lifeLeft - state.now;
      if (by > 0) emit({ op: "advance", by });
    }
  }
  for (let index = 0; index < length; index += 1) {
    const op = chooseOp(rng, state, walk, profile);
    // Usually a create is followed by the wallet's own view of the invoice.
    const pairRow =
      op.op === "create" && !state.attempts.has(op.id) && rng.chance(0.55)
        ? { op: "wallet", id: op.id, state: rng.pick(["pending", "stateless"]) }
        : null;
    // Land exactly on a boundary, then scan it.
    const pairScan = op.op === "advance" && rng.chance(0.55) ? { op: "scan", mode: "ok" } : null;
    // A notification delivered twice, at the same instant or a little later.
    const pairNotify =
      op.op === "notify" && op.kind === "received" && rng.chance(0.2) ? { ...op } : null;
    emit(op);
    for (const follow of [pairRow, pairScan, pairNotify]) {
      if (follow !== null) emit(follow);
    }
    if (ops.length >= maxSteps) break;
  }
  return ops;
}

/** Sequence tags, for reading the vector file and asserting the corpus covers every behavior. */
export function coverageOf(sequences) {
  const counts = new Map();
  const bump = (tag) => counts.set(tag, (counts.get(tag) ?? 0) + 1);
  for (const sequence of sequences) {
    const reasons = new Set();
    const closed = new Set();
    const walletExpiry = new Map();
    const statusOf = new Map();
    const unknownAtDelivery = new Set();
    for (const step of sequence.steps) {
      if (step.expires_at !== undefined && !walletExpiry.has(step.id)) {
        walletExpiry.set(step.id, step.expires_at);
      }
      if (step.op === "notify") {
        if (!statusOf.has(step.id)) {
          bump("notify:hash_unknown_at_delivery");
          unknownAtDelivery.add(step.id);
        }
      }
      if (step.outcome === "inserted" && unknownAtDelivery.has(step.id)) {
        bump("notify:row_created_after_notification");
      }
      if (step.op === "scan" && step.reason === "ran") {
        for (const [id, status] of statusOf) {
          if (status !== "pending" || (step.rows?.[id] ?? [status])[0] !== "pending") continue;
          if (step.t === walletExpiry.get(id) + GRACE_SECONDS - 1) {
            bump("boundary:still_open_one_second_before_grace");
          }
        }
      }
      for (const [id, row] of Object.entries(step.rows ?? {})) {
        const [status, reason] = row;
        if (status === "expired" || status === "failed" || status === "attention") {
          closed.add(Number(id));
          if (
            statusOf.get(Number(id)) === "pending" &&
            step.t === walletExpiry.get(Number(id)) + GRACE_SECONDS
          ) {
            bump("boundary:closed_exactly_at_expiry_plus_grace");
          }
        }
        statusOf.set(Number(id), status);
        if (reason !== null) reasons.add(reason);
        bump(`status:${status}`);
        if (reason !== null) bump(`reason:${reason}`);
      }
      bump(`op:${step.op}`);
      if (step.op === "scan") bump(`scan:${step.mode}`);
      if (step.outcome !== undefined) bump(`outcome:${step.op}:${step.outcome}`);
      if (step.fulfilled !== undefined) bump("fulfilled");
      if (step.fail_fulfillment) bump("fail_fulfillment");
      if (step.op === "notify") bump(`notify:${step.kind}:${step.finality}`);
      if (step.op === "wallet") bump(`wallet:${step.state}`);
      if (step.op === "wallet" && step.state.startsWith("settled") && closed.has(step.id)) {
        bump("late_payment_on_closed");
      }
    }
    for (const reason of reasons) bump(`sequence_reason:${reason}`);
  }
  return Object.fromEntries([...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function generateSequences({ seed, count, maxSteps = DEFAULT_MAX_STEPS }) {
  const sequences = [];
  for (let index = 0; index < count; index += 1) {
    const sequenceSeed = (seed + index) >>> 0;
    sequences.push({
      name: `seed-${sequenceSeed}`,
      seed: sequenceSeed,
      steps: generateOps(sequenceSeed, maxSteps),
    });
  }
  return sequences;
}

const HOW_TO_READ = [
  "Each sequence is a list of steps. A step's `op` plus its fields say what happens; `t` is the clock (unix seconds) the step runs at.",
  "`create`: the route's selection, then a mint and commit, for `ref` on `rail` (`ln` or a swap asset). `outcome` is `inserted`, `reused` (with `reused_id`) or `already_paid`.",
  "`commit`: the repository commit alone (a concurrent create that already passed selection, or a retry of a known hash). `outcome` is `inserted`, `idempotent` or `conflict`.",
  "`wallet` sets what the fake wallet shows for an id: `absent`, `stateless` (no NIP-47 state), `pending`, `accepted`, `failed`, `expired`, `settled_at` (settled_at only), `settled_state` (state only), `settled_full` (both).",
  "`notify` delivers one NWC notification: `kind` is `received` (payment_received) or `sent` (any other type), `finality` is `settled_at`, `state`, `preimage`, `none`, or `absent` (no payload).",
  "`scan` runs one reconcile pass with wallet mode `ok`, `fail`, `unrecognized_key`, `unrecognized_type`, `unusable_rows`, or `fail_after_N` (the first N list_transactions calls succeed).",
  "`replay_settlement` re-delivers a settlement straight to the repository; `stale_close` re-delivers a closing transition for a row that is no longer pending. `fail_fulfillment` makes the host's hook raise during that step.",
  "`restart` rebuilds every library object over the same database. `advance` moves the clock.",
  "`rows` are the rows changed by the step: id -> [status, status_reason, paid_at]. `fulfilled` lists the [reference, id] entries the step added to the host ledger. `reason` is the reconcile pass's outcome. A row not in `rows` is unchanged.",
  "An id n is the payment hash n in 64 lowercase hex digits; invoices carry created_at_source=wallet.",
];

function renderFile(sequences) {
  const header = {
    description:
      "Model-generated sequences over the payment-attempt state machine (AGENTS.md Non-negotiables). Each engine replays every sequence through its real repository, reconciler and notification path, comparing every row, the fulfillment ledger and each operation's outcome after every step, and checking the invariants independently. Generated by tools/attempt-model/generate.mjs; do not edit by hand.",
    how_to_read: HOW_TO_READ,
    schema_version: 1,
    generator: { seed: VECTOR_SEED, count: VECTOR_COUNT },
    expiry_grace_seconds: GRACE_SECONDS,
    reuse_buffer_seconds: REUSE_BUFFER_SECONDS,
    minimum_scan_gap_seconds: MIN_SCAN_GAP_SECONDS,
    swap_assets: SWAP_ASSETS,
    scan_modes: SCAN_MODES,
    notification_finalities: NOTIFICATION_FINALITIES,
    coverage: coverageOf(sequences),
  };
  const headerText = JSON.stringify(header, null, 2).replace(/\n}$/, "");
  const body = sequences.map((sequence) => `    ${JSON.stringify(sequence)}`).join(",\n");
  return `${headerText},\n  "sequences": [\n${body}\n  ]\n}\n`;
}

export function vectorFileText() {
  return renderFile(generateSequences({ seed: VECTOR_SEED, count: VECTOR_COUNT }));
}

function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function main(argv) {
  const target = path.join(repoRoot(), VECTOR_FILE);
  const text = vectorFileText();
  if (argv.includes("--check")) {
    if (readFileSync(target, "utf8") !== text) {
      console.error(`${VECTOR_FILE} is stale; run \`npm run generate:model-vectors\`.`);
      process.exitCode = 1;
    }
    return;
  }
  writeFileSync(target, text);
  console.log(`wrote ${VECTOR_FILE}: ${Buffer.byteLength(text)} bytes`);
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main(process.argv.slice(2));
}
