// Two lifetime edge cases, run through the real mounted handler, repository and
// reconcile gate over SQLite with the in-process fake wallet.
//
// 1. The merchant changes the wallet code while invoices are pending. A row
//    records nothing about the wallet that minted it, so a new code pointed at
//    the same wallet carries on, and a code pointed at another wallet can never
//    see the old invoice settle.
// 2. The host's order goes away while the payer is paying. Settlement is keyed
//    by the attempt row, never by the host's order, so `onPaid` still fires and
//    the host decides.
import assert from "node:assert/strict";
import test from "node:test";
import {
  createHost,
  createHttpHandler,
  startNotificationListener,
} from "../packages/js/http/src/index.ts";
import { createOpenReceive } from "../packages/js/node/src/index.ts";
import { createTestkitReceiveClient } from "../packages/js/testkit/src/index.ts";
import { memoryPaymentsDb } from "./helpers/factories.mjs";

const GRACE_SECONDS = 900;
// The gate floor for a young invoice; a later request runs a fresh pass.
const GATE_SECONDS = 3;

function fixture() {
  const state = { now: 1_000 };
  const clock = () => state.now;
  const db = memoryPaymentsDb();
  db.exec("CREATE TABLE fulfilled (reference TEXT NOT NULL)");
  const orders = new Map();
  const refused = new Set();
  const paid = [];
  const hookState = { fail: () => undefined };
  return {
    state,
    clock,
    db,
    orders,
    refused,
    paid,
    hookState,
    logs: [],
    wallet: () => createTestkitReceiveClient({ now: clock }),
    /** A shop process: a fresh service, host and handler over the same database. */
    async start(wallet) {
      const service = await createOpenReceive({
        client: wallet,
        clock,
        logger: (entry) => this.logs.push(entry),
      });
      const host = createHost({
        db,
        clock,
        amountFor: (reference) => orders.get(reference) ?? null,
        onPaid: async (settlement) => {
          await settlement.query("INSERT INTO fulfilled (reference) VALUES (?)", [
            settlement.reference,
          ]);
          const failure = hookState.fail(settlement);
          if (failure !== undefined) throw failure;
          paid.push(settlement);
        },
      });
      const handler = createHttpHandler({
        service,
        host,
        clock,
        authorize: ({ resource }) => !refused.has(resource.reference),
      });
      return { service, host, handler };
    },
  };
}

function connectionTo(wallet) {
  return {
    preflight: () => wallet.preflight(),
    makeInvoice: (request) => wallet.makeInvoice(request),
    listTransactions: (request, options) => wallet.listTransactions(request, options),
  };
}

async function post(shop, path, body) {
  const response = await shop.handler(
    new Request(`http://test/openreceive${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() };
}

async function checkout(fix, shop, reference, sats = 100) {
  fix.orders.set(reference, { sats });
  const created = await post(shop, "/checkouts", { reference });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.checkout;
}

const check = (shop, reference, paymentHash) =>
  post(shop, "/payments/check", { reference, payment_hash: paymentHash });

function row(fix, paymentHash) {
  return {
    ...fix.db
      .prepare(
        "SELECT status, status_reason, paid_at FROM openreceive_payments WHERE payment_hash = ?",
      )
      .get(paymentHash),
  };
}

function fulfilledRows(fix) {
  return fix.db
    .prepare("SELECT reference FROM fulfilled")
    .all()
    .map((row) => row.reference);
}

function captureWarnings(t) {
  return t.mock.method(console, "warn", () => {});
}

/** The fake wallet's hashes are its mint counter; an old wallet with history keeps them apart. */
async function walletWithHistory(fix) {
  const wallet = fix.wallet();
  for (let index = 0; index < 32; index += 1) await wallet.makeInvoice({ amount_msats: 1_000 });
  return wallet;
}

test("a new code for the SAME wallet keeps the pending invoice paying, exactly once", async (t) => {
  const warn = captureWarnings(t);
  const fix = fixture();
  const wallet = fix.wallet();
  const before = await fix.start(connectionTo(wallet));
  const invoice = await checkout(fix, before, "order-a");

  // The shop restarts on another NWC connection to the wallet that minted the invoice.
  const after = await fix.start(connectionTo(wallet));
  wallet.settleInvoice({ payment_hash: invoice.payment_hash }, { settled_at: fix.state.now + 1 });
  fix.state.now += GATE_SECONDS;
  const settled = await check(after, "order-a", invoice.payment_hash);
  assert.equal(settled.status, 200);
  assert.equal(settled.body.status, "settled");
  assert.deepEqual(
    fix.paid.map((payment) => [payment.reference, payment.paymentHash]),
    [["order-a", invoice.payment_hash]],
  );

  // A later pass and a retried create never fulfill again.
  fix.state.now += 100;
  assert.equal((await check(after, "order-a", invoice.payment_hash)).body.status, "settled");
  assert.equal((await post(after, "/checkouts", { reference: "order-a" })).status, 409);
  assert.deepEqual(fulfilledRows(fix), ["order-a"]);
  assert.equal(warn.mock.calls.length, 0);
});

test("a code for a DIFFERENT wallet: the old invoice never reads as paid and expires normally", async (t) => {
  const warn = captureWarnings(t);
  const fix = fixture();
  const oldWallet = await walletWithHistory(fix);
  const before = await fix.start(oldWallet);
  const stranded = await checkout(fix, before, "order-a");

  const newWallet = fix.wallet();
  const minted = newWallet.listInvoices().length;
  const after = await fix.start(newWallet);
  // The payer's wallet pays the old invoice; the new wallet's history never shows it.
  oldWallet.settleInvoice(
    { payment_hash: stranded.payment_hash },
    { settled_at: fix.state.now + 1 },
  );
  assert.equal(
    newWallet.listInvoices().some((row) => row.payment_hash === stranded.payment_hash),
    false,
  );

  // Every poll is an ordinary "still pending": no crash, no failed pass.
  for (let poll = 0; poll < 5; poll += 1) {
    fix.state.now += GATE_SECONDS;
    const pending = await check(after, "order-a", stranded.payment_hash);
    assert.equal(pending.status, 200, JSON.stringify(pending.body));
    assert.equal(pending.body.status, "pending");
  }
  assert.equal(row(fix, stranded.payment_hash).status, "pending");

  // A retry of the SAME order is still served the old wallet's invoice while it
  // is reusable: nothing on the row says which wallet minted it.
  fix.state.now += 10;
  const retried = await post(after, "/checkouts", { reference: "order-a" });
  assert.equal(retried.status, 201);
  assert.equal(retried.body.checkout.payment_hash, stranded.payment_hash);
  assert.equal(retried.body.checkout.bolt11, stranded.bolt11);
  assert.equal(newWallet.listInvoices().length, minted, "the new wallet minted nothing");

  // A brand-new order mints on, and settles from, the new wallet.
  const fresh = await checkout(fix, after, "order-b");
  assert.notEqual(fresh.payment_hash, stranded.payment_hash);
  newWallet.settleInvoice({ payment_hash: fresh.payment_hash }, { settled_at: fix.state.now });
  fix.state.now += GATE_SECONDS;
  assert.equal((await check(after, "order-b", fresh.payment_hash)).body.status, "settled");
  assert.deepEqual(
    fix.paid.map((payment) => payment.reference),
    ["order-b"],
  );

  // One second short of expiry plus grace the row is still open.
  fix.state.now = stranded.expires_at + GRACE_SECONDS - 1;
  await check(after, "order-a", stranded.payment_hash);
  assert.equal(row(fix, stranded.payment_hash).status, "pending");

  // A complete scan at expiry plus grace closes it as the normal never-paid case.
  fix.state.now = stranded.expires_at + GRACE_SECONDS + 12;
  const expired = await check(after, "order-a", stranded.payment_hash);
  assert.equal(expired.status, 200);
  assert.equal(expired.body.status, "expired");
  assert.deepEqual(row(fix, stranded.payment_hash), {
    status: "expired",
    status_reason: "not_found_after_expiry",
    paid_at: null,
  });

  // Never a false paid, no failed pass, and a new attempt for the order works on the new wallet.
  assert.deepEqual(fulfilledRows(fix), ["order-b"]);
  assert.equal(warn.mock.calls.length, 0, "every pass over the stranded row succeeded");
  const replacement = await checkout(fix, after, "order-a");
  assert.notEqual(replacement.payment_hash, stranded.payment_hash);
});

test("a payment that landed on the old wallet is reported to the merchant", {
  skip: "bug: closing an attempt the current wallet never knew logs nothing; the payment stays with the old wallet unnoticed",
}, async (t) => {
  captureWarnings(t);
  const fix = fixture();
  const oldWallet = await walletWithHistory(fix);
  const before = await fix.start(oldWallet);
  const stranded = await checkout(fix, before, "order-a");
  const after = await fix.start(fix.wallet());
  oldWallet.settleInvoice({ payment_hash: stranded.payment_hash });
  fix.state.now = stranded.expires_at + GRACE_SECONDS + 12;
  await check(after, "order-a", stranded.payment_hash);
  assert.equal(row(fix, stranded.payment_hash).status, "expired");
  assert.ok(
    fix.logs.some((entry) => entry.level === "warn" || entry.level === "error"),
    `expected a warning that the row closed unseen, got ${JSON.stringify(fix.logs.map((entry) => entry.event))}`,
  );
});

test("an order cancelled mid-payment (no price, row gone) still reaches onPaid, exactly once", async (t) => {
  const warn = captureWarnings(t);
  const fix = fixture();
  const wallet = fix.wallet();
  const shop = await fix.start(wallet);
  const invoice = await checkout(fix, shop, "order-a");

  fix.orders.delete("order-a");
  wallet.settleInvoice({ payment_hash: invoice.payment_hash }, { settled_at: fix.state.now + 1 });
  fix.state.now += GATE_SECONDS;

  const settled = await check(shop, "order-a", invoice.payment_hash);
  assert.equal(settled.status, 200);
  assert.equal(settled.body.status, "settled");
  assert.deepEqual(fulfilledRows(fix), ["order-a"]);

  fix.state.now += 50;
  assert.equal((await check(shop, "order-a", invoice.payment_hash)).body.status, "settled");
  assert.deepEqual(fulfilledRows(fix), ["order-a"], "a replayed pass never fulfills again");
  assert.equal(warn.mock.calls.length, 0);
});

test("authorize refusing the status poll does not stop settlement", async (t) => {
  captureWarnings(t);
  const fix = fixture();
  const wallet = fix.wallet();
  const shop = await fix.start(wallet);
  const invoice = await checkout(fix, shop, "order-a");

  fix.refused.add("order-a");
  wallet.settleInvoice({ payment_hash: invoice.payment_hash }, { settled_at: fix.state.now + 1 });
  fix.state.now += GATE_SECONDS;

  // The pass runs before authorize, so the host still hears about the money.
  const refused = await check(shop, "order-a", invoice.payment_hash);
  assert.equal(refused.status, 403);
  assert.deepEqual(fulfilledRows(fix), ["order-a"]);
  assert.equal(row(fix, invoice.payment_hash).status, "settled");
});

test("a host handler that raises rolls back and is retried, then fulfills once", async (t) => {
  const warn = captureWarnings(t);
  const fix = fixture();
  const wallet = fix.wallet();
  const shop = await fix.start(wallet);
  const invoice = await checkout(fix, shop, "order-a");

  fix.hookState.fail = () => new Error("the order row is gone");
  wallet.settleInvoice({ payment_hash: invoice.payment_hash }, { settled_at: fix.state.now + 1 });
  fix.state.now += GATE_SECONDS;
  const pending = await check(shop, "order-a", invoice.payment_hash);
  assert.equal(pending.status, 200);
  assert.equal(pending.body.status, "pending", "a failed hook reports the committed state");
  assert.equal(row(fix, invoice.payment_hash).status, "pending");
  assert.deepEqual(fulfilledRows(fix), [], "the hook's write rolled back with the settlement");
  assert.ok(
    warn.mock.calls.some((call) => String(call.arguments[0]).includes("the order row is gone")),
  );

  fix.hookState.fail = () => undefined;
  fix.state.now += GATE_SECONDS;
  const settled = await check(shop, "order-a", invoice.payment_hash);
  assert.equal(settled.body.status, "settled");
  assert.equal(fix.paid.length, 1);
  assert.deepEqual(fulfilledRows(fix), ["order-a"]);
});

test("a hook that raises forever never closes the row and never starves another order", async (t) => {
  const warn = captureWarnings(t);
  const fix = fixture();
  const wallet = fix.wallet();
  const shop = await fix.start(wallet);
  const doomed = await checkout(fix, shop, "order-doomed");
  const healthy = await checkout(fix, shop, "order-ok");

  fix.hookState.fail = ({ reference }) =>
    reference === "order-doomed" ? new Error("the order row is gone") : undefined;
  wallet.settleInvoice({ payment_hash: doomed.payment_hash }, { settled_at: fix.state.now + 1 });
  wallet.settleInvoice({ payment_hash: healthy.payment_hash }, { settled_at: fix.state.now + 1 });
  fix.state.now += GATE_SECONDS;
  await check(shop, "order-ok", healthy.payment_hash);
  assert.equal(row(fix, healthy.payment_hash).status, "settled");
  assert.deepEqual(fulfilledRows(fix), ["order-ok"]);

  for (let pass = 0; pass < 3; pass += 1) {
    fix.state.now = doomed.expires_at + GRACE_SECONDS + (pass + 1) * 20;
    const answer = await check(shop, "order-doomed", doomed.payment_hash);
    assert.equal(answer.body.status, "pending");
    assert.equal(
      row(fix, doomed.payment_hash).status,
      "pending",
      "paid, so never closed as expired",
    );
  }
  assert.ok(warn.mock.calls.length >= 3, "each failed pass reports the failure");
  assert.deepEqual(fulfilledRows(fix), ["order-ok"]);
});

test("a notification for a cancelled order settles it once, and a raising hook falls back to the next pass", async (t) => {
  captureWarnings(t);
  const fix = fixture();
  const wallet = fix.wallet();
  const shop = await fix.start(wallet);
  const invoice = await checkout(fix, shop, "order-a");
  fix.orders.delete("order-a");

  fix.hookState.fail = () => new Error("the order row is gone");
  const listener = await startNotificationListener({
    service: { subscribeWalletNotifications: (handler) => wallet.subscribeNotifications(handler) },
    host: shop.host,
    onError: () => {},
  });
  wallet.settleInvoice(
    { payment_hash: invoice.payment_hash },
    { settled_at: fix.state.now + 1, notify: true },
  );
  for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  await listener.stop();
  assert.equal(row(fix, invoice.payment_hash).status, "pending", "the raising hook rolled back");

  fix.hookState.fail = () => undefined;
  fix.state.now += GATE_SECONDS;
  assert.equal((await check(shop, "order-a", invoice.payment_hash)).body.status, "settled");
  assert.deepEqual(fulfilledRows(fix), ["order-a"]);
});
