// The JS engine's runner for spec/test-vectors/attempt-state-machine.json: one
// operation sequence replayed through the real createHost / createSqlPayments /
// maybeReconcilePayments / startNotificationListener over a real SQLite
// database, comparing the model's prediction after every step and checking the
// invariants against the engine's own rows.
//
// Date.now is faked for the run: the notification listener and its fallback
// pass read the system clock (they take no injected clock) and the scan
// deadline is measured against it.

import { scanPaymentSlice } from "../../packages/js/core/src/payment-scan.ts";
import {
  createHost,
  maybeReconcilePayments,
  startNotificationListener,
} from "../../packages/js/http/src/index.ts";
import {
  normalizeListTransactionsResult,
  normalizeNwcNotification,
} from "../../packages/js/node/src/nwc/normalize.ts";
import { memoryPaymentsDb } from "./factories.mjs";

const STATUSES = new Set(["pending", "settled", "expired", "failed", "attention"]);
const GRACE_SECONDS = 900;
const WALLET_SETTLED_STATES = new Set(["settled_at", "settled_state", "settled_full"]);
const WALLET_TERMINAL_STATES = new Set(["failed", "expired"]);

const hashOf = (id) => id.toString(16).padStart(64, "0");
const walletRowIsSettled = (row) => WALLET_SETTLED_STATES.has(row.state);

class CheckFailed extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

class JsHarness {
  constructor() {
    this.now = 0;
    this.db = memoryPaymentsDb();
    this.ledger = [];
    this.failFulfillment = false;
    this.walletMode = "ok";
    this.walletCalls = 0;
    this.walletRows = new Map();
    this.notificationHandler = undefined;
    this.notificationListener = undefined;
    this.rebuild();
  }

  rebuild() {
    const clock = () => this.now;
    const fulfill = (settlement) => {
      if (this.failFulfillment) throw new Error("host rollback (model)");
      this.ledger.push([settlement.reference, settlement.paymentHash]);
    };
    this.fulfill = fulfill;
    this.host = createHost({ db: this.db, clock, amountFor: () => ({ sats: 1 }), onPaid: fulfill });
    this.service = {
      scanPaymentSlice: (input) =>
        scanPaymentSlice({
          ...input,
          clock,
          client: { listTransactions: async (request) => this.listTransactions(request) },
        }),
      subscribeWalletNotifications: async (handler) => {
        this.notificationHandler = handler;
        return () => {};
      },
    };
  }

  listTransactions(request) {
    const callIndex = this.walletCalls;
    this.walletCalls += 1;
    if (this.walletMode === "fail") throw new Error("wallet unavailable (model)");
    if (this.walletMode === "unrecognized_key")
      return normalizeListTransactionsResult({ rows: [] });
    if (this.walletMode === "unrecognized_type") {
      return normalizeListTransactionsResult({ transactions: "nope" });
    }
    if (this.walletMode === "unusable_rows") {
      return normalizeListTransactionsResult({ transactions: [1, 2] });
    }
    if (this.walletMode.startsWith("fail_after_")) {
      if (callIndex >= Number(this.walletMode.slice(11)))
        throw new Error("wallet unavailable (model)");
    }
    const until = request.until ?? Number.MAX_SAFE_INTEGER;
    const rows = [...this.walletRows.entries()]
      .map(([id, row]) => ({ id, ...row }))
      .filter((row) => row.createdAt >= (request.from ?? 0) && row.createdAt <= until)
      .filter((row) => request.unpaid === true || walletRowIsSettled(row))
      .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
    const page = rows.slice(request.offset ?? 0, (request.offset ?? 0) + request.limit);
    return normalizeListTransactionsResult({
      transactions: page.map((row) => this.walletWireRow(row)),
    });
  }

  walletWireRow(row) {
    const wire = {
      type: "incoming",
      payment_hash: hashOf(row.id),
      amount: 1000,
      created_at: row.createdAt,
    };
    if (row.state === "settled_at") return { ...wire, settled_at: row.settledAt };
    if (row.state === "settled_full")
      return { ...wire, state: "settled", settled_at: row.settledAt };
    if (row.state === "settled_state") return { ...wire, state: "settled" };
    if (row.state !== "stateless") return { ...wire, state: row.state };
    return wire;
  }

  setWalletRow(id, kind, settledAt, createdAt) {
    if (kind === "absent") {
      this.walletRows.delete(id);
      return;
    }
    const existing = this.walletRows.get(id);
    this.walletRows.set(id, {
      createdAt: existing?.createdAt ?? createdAt,
      state: kind,
      settledAt,
    });
  }

  applyWalletFromNotify(step) {
    if (step.kind === "sent") return;
    if (step.finality === "settled_at") {
      this.setWalletRow(step.id, "settled_full", step.settled_at, step.created_at);
    } else if (step.finality === "state") {
      this.setWalletRow(step.id, "settled_state", undefined, step.created_at);
    }
  }

  checkoutFor(step) {
    return {
      reference: step.ref,
      paymentHash: hashOf(step.id),
      bolt11: `lnbc-${step.id}`,
      amountMsats: 1000,
      createdAt: step.created_at,
      createdAtSource: "wallet",
      expiresAt: step.expires_at,
      fiatQuote: null,
    };
  }

  swapDataFor(step) {
    if (step.rail === "ln") return undefined;
    return {
      version: 1,
      providerOrder: {
        provider: "model",
        provider_order_id: `order-${step.id}`,
        provider_token: "model-token",
        pay_in_asset: step.rail,
        expires_at: step.deposit_expires_at,
      },
    };
  }

  commitInput(step) {
    const swapData = this.swapDataFor(step);
    return {
      reference: step.ref,
      paymentHash: hashOf(step.id),
      checkout: this.checkoutFor(step),
      ...(swapData === undefined ? {} : { swapData }),
    };
  }

  async applyStep(step) {
    this.walletCalls = 0;
    this.walletMode = "ok";
    this.failFulfillment = step.fail_fulfillment === true;
    this.lastReason = undefined;
    this.outcome = undefined;
    this.reusedId = undefined;
    switch (step.op) {
      case "advance":
        return;
      case "restart":
        this.rebuild();
        return;
      case "wallet":
        this.setWalletRow(step.id, step.state, step.settled_at, step.created_at);
        return;
      case "create":
        await this.create(step);
        return;
      case "commit":
        try {
          await this.host.payments.commitAttempt(this.commitInput(step));
          this.outcome = "inserted_or_idempotent";
        } catch (error) {
          // A 409 from the repository, or the payment_hash UNIQUE constraint
          // refusing a hash held by another reference.
          if (error?.status !== 409 && !/unique/i.test(String(error?.message))) throw error;
          this.outcome = "conflict";
        }
        return;
      case "scan":
        this.walletMode = step.mode;
        await this.scan();
        return;
      case "notify":
        await this.notify(step);
        return;
      case "replay_settlement":
        try {
          await this.host.payments.markPaidOnce(
            { paymentHash: hashOf(step.id), paidAt: step.paid_at },
            this.fulfill,
          );
        } catch (error) {
          if (!this.failFulfillment) throw error;
        }
        return;
      case "stale_close":
        await this.host.payments.recordReconciliation({
          paymentHash: hashOf(step.id),
          status: step.status,
          observedAt: this.now,
          reason: "stale_model",
        });
        return;
      default:
        throw new Error(`unknown op ${step.op}`);
    }
  }

  async create(step) {
    const action = step.rail === "ln" ? "checkout.create" : "swap.create";
    try {
      const resolved = await this.host.resolveCheckout({
        action,
        reference: step.ref,
        input: {},
        request: new Request("http://model.test/"),
        ...(step.rail === "ln" ? {} : { payInAsset: step.rail }),
      });
      if (resolved.paymentHash !== undefined) {
        this.outcome = "reused";
        this.reusedId = Number.parseInt(resolved.paymentHash, 16);
        return;
      }
    } catch (error) {
      if (error?.status === 409) {
        this.outcome = "already_paid";
        return;
      }
      throw error;
    }
    await this.host.onCheckoutCreated(this.commitInput(step));
    this.outcome = "inserted";
  }

  async scan() {
    const result = await maybeReconcilePayments({
      host: this.host,
      service: this.service,
      clock: () => this.now,
      onError: () => {},
    });
    this.lastReason = result.reason;
  }

  async notify(step) {
    this.applyWalletFromNotify(step);
    const listener = await startNotificationListener({
      service: this.service,
      host: this.host,
      onError: () => {},
    });
    this.notificationHandler(normalizeNwcNotification(this.notificationPayload(step)));
    // The listener's work is promise-chained; a macrotask yield lets it finish
    // before stop() (which would otherwise short-circuit a pending settlement).
    for (let tick = 0; tick < 5; tick += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await listener.stop();
  }

  notificationPayload(step) {
    const type = step.kind === "sent" ? "payment_sent" : "payment_received";
    if (step.finality === "absent") return { notification_type: type };
    const payload = { payment_hash: hashOf(step.id), amount: 1000 };
    if (step.finality === "settled_at") {
      return {
        notification_type: type,
        notification: {
          ...payload,
          type: "incoming",
          state: "settled",
          settled_at: step.settled_at,
        },
      };
    }
    if (step.finality === "state") {
      return {
        notification_type: type,
        notification: { ...payload, type: "incoming", state: "settled" },
      };
    }
    if (step.finality === "preimage") {
      return { notification_type: type, notification: { ...payload, preimage: "a".repeat(64) } };
    }
    return { notification_type: type, notification: payload };
  }

  async readRow(id) {
    const row = await this.host.payments.findByPaymentHash(hashOf(id));
    if (row === undefined) return undefined;
    return {
      status: row.status,
      reason: row.statusReason ?? null,
      paidAt: row.paidAt,
      reference: row.reference,
      expiresAt: row.expiresAt,
      hasSwap: row.swapData !== undefined && row.swapData !== null,
    };
  }

  rowCounts() {
    const { total, distinct } = this.db
      .prepare(
        "SELECT COUNT(*) AS total, COUNT(DISTINCT payment_hash) AS distinct_hashes FROM openreceive_payments",
      )
      .get();
    return { total, distinct: distinct ?? this.distinctOf() };
  }

  distinctOf() {
    return this.db
      .prepare("SELECT COUNT(DISTINCT payment_hash) AS n FROM openreceive_payments")
      .get().n;
  }

  close() {
    this.db.close();
  }
}

const closedStatuses = new Set(["expired", "failed", "attention"]);

function checkInvariants(harness, step, before, after, info) {
  for (const [id, row] of after) {
    if (!STATUSES.has(row.status)) {
      throw new CheckFailed("invariant", `row ${id} has status ${row.status}`);
    }
    const previous = before.get(id);
    if (previous?.status === "settled") {
      if (
        row.status !== "settled" ||
        row.paidAt !== previous.paidAt ||
        row.reason !== previous.reason
      ) {
        throw new CheckFailed(
          "invariant",
          `settled row ${id} was overwritten: ${JSON.stringify(row)}`,
        );
      }
    }
    if (previous !== undefined && previous.status !== "pending" && row.status !== previous.status) {
      throw new CheckFailed("invariant", `closed row ${id} changed status to ${row.status}`);
    }
    if (previous?.status === "pending" && closedStatuses.has(row.status)) {
      const attempt = info.get(id);
      const ranScan =
        step.op === "scan"
          ? step.mode === "ok" || step.mode.startsWith("fail_after_")
          : step.op === "notify";
      if (!ranScan) {
        throw new CheckFailed("invariant", `row ${id} closed without a wallet scan (${step.op})`);
      }
      if (step.op === "scan" && step.mode !== "ok" && !step.mode.startsWith("fail_after_")) {
        throw new CheckFailed("invariant", `a ${step.mode} scan closed row ${id}`);
      }
      const walletRow = harness.walletRows.get(id);
      const walletTerminal = walletRow !== undefined && WALLET_TERMINAL_STATES.has(walletRow.state);
      if (!walletTerminal && harness.now < attempt.expiresAt + GRACE_SECONDS) {
        throw new CheckFailed(
          "invariant",
          `row ${id} closed before expiry + grace (now ${harness.now}, expires ${attempt.expiresAt})`,
        );
      }
    }
  }
  for (const [ref] of harness.ledger) {
    if (harness.ledger.filter((entry) => entry[0] === ref).length > 1) {
      throw new CheckFailed("invariant", `reference ${ref} was fulfilled more than once`);
    }
  }
  const settledByRef = new Map();
  for (const [id, row] of after) {
    if (row.status !== "settled") continue;
    const list = settledByRef.get(row.reference) ?? [];
    list.push([id, row]);
    settledByRef.set(row.reference, list);
  }
  for (const [ref, rows] of settledByRef) {
    const ledgerEntries = harness.ledger.filter((entry) => entry[0] === ref);
    if (ledgerEntries.length !== 1) {
      throw new CheckFailed(
        "invariant",
        `reference ${ref} has settled rows but ${ledgerEntries.length} fulfillments`,
      );
    }
    const fulfilledHash = ledgerEntries[0][1];
    const first = rows.filter(([, row]) => row.reason === null);
    if (first.length !== 1 || hashOf(first[0][0]) !== fulfilledHash) {
      throw new CheckFailed(
        "invariant",
        `fulfillment for ${ref} did not go to its first settled attempt`,
      );
    }
    for (const [id, row] of rows) {
      if (row.reason !== null && row.reason !== "duplicate_settlement") {
        throw new CheckFailed("invariant", `settled row ${id} has reason ${row.reason}`);
      }
    }
  }
  const live = new Map();
  for (const [id, row] of after) {
    if (row.status !== "pending" || row.reason === "superseded" || row.expiresAt <= harness.now)
      continue;
    const key = `${row.reference} ${row.hasSwap ? info.get(id).rail : "ln"}`;
    if (live.has(key)) {
      throw new CheckFailed("invariant", `two live attempts on ${key}: ${live.get(key)} and ${id}`);
    }
    live.set(key, id);
  }
  const counts = harness.rowCounts();
  if (counts.total !== counts.distinct) {
    throw new CheckFailed("invariant", "payment_hash is not unique");
  }
}

const rowEquals = (row, expected) =>
  row !== undefined &&
  row.status === expected[0] &&
  (row.reason ?? null) === expected[1] &&
  (row.paidAt ?? null) === expected[2];

export async function runSequence(sequence) {
  const realDateNow = Date.now;
  const harness = new JsHarness();
  const expected = new Map();
  const expectedLedger = [];
  const info = new Map();
  try {
    let current = new Map();
    for (const [index, step] of sequence.steps.entries()) {
      try {
        harness.now = step.t;
        Date.now = () => harness.now * 1000;
        await harness.applyStep(step);
        if (step.outcome !== undefined) {
          const actual =
            step.op === "commit" && harness.outcome === "inserted_or_idempotent"
              ? step.outcome === "idempotent" || step.outcome === "inserted"
                ? step.outcome
                : "inserted_or_idempotent"
              : harness.outcome;
          if (actual !== step.outcome) {
            throw new CheckFailed("outcome", `expected ${step.outcome}, engine ${actual}`);
          }
          if (step.outcome === "reused" && harness.reusedId !== step.reused_id) {
            throw new CheckFailed(
              "outcome",
              `reused ${harness.reusedId}, expected ${step.reused_id}`,
            );
          }
        }
        if (step.reason !== undefined && harness.lastReason !== step.reason) {
          throw new CheckFailed("outcome", `reason ${harness.lastReason}, expected ${step.reason}`);
        }
        for (const [id, row] of Object.entries(step.rows ?? {})) {
          const numericId = Number(id);
          if (!expected.has(numericId)) {
            info.set(numericId, {
              expiresAt: step.expires_at,
              rail: step.rail,
              rowExpiresAt: step.deposit_expires_at ?? step.expires_at,
            });
          }
          expected.set(numericId, row);
        }
        for (const entry of step.fulfilled ?? []) expectedLedger.push(entry);
        const after = new Map();
        for (const id of expected.keys()) after.set(id, await harness.readRow(id));
        checkInvariants(harness, step, current, after, info);
        for (const [id, row] of expected) {
          if (!rowEquals(after.get(id), row)) {
            throw new CheckFailed(
              "state",
              `row ${id}: engine ${JSON.stringify(after.get(id))}, model ${JSON.stringify(row)}`,
            );
          }
        }
        if (harness.rowCounts().total !== expected.size) {
          throw new CheckFailed("state", "the engine holds rows the model does not");
        }
        const ledger = harness.ledger.map(([ref, hash]) => [ref, Number.parseInt(hash, 16)]);
        if (JSON.stringify(ledger) !== JSON.stringify(expectedLedger)) {
          throw new CheckFailed(
            "state",
            `fulfillment ledger ${JSON.stringify(ledger)}, model ${JSON.stringify(expectedLedger)}`,
          );
        }
        current = after;
      } catch (error) {
        return {
          name: sequence.name,
          ok: false,
          step: index,
          kind: error instanceof CheckFailed ? error.kind : "error",
          message: error instanceof Error ? (error.stack ?? error.message) : String(error),
        };
      }
    }
    return { name: sequence.name, ok: true };
  } finally {
    Date.now = realDateNow;
    harness.close();
  }
}
