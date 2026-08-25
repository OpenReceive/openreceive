import assert from "node:assert/strict";
import test from "node:test";

import { deriveStatus } from "../packages/js/browser/src/index.ts";

// deriveStatus() follows the server's transaction_state verdict. It never re-derives
// settlement from a timestamp: the settlement rule lives in @openreceive/core
// and is not duplicated in the browser.
test("status follows transaction_state and the expiry clock", () => {
  assert.equal(deriveStatus({ transaction_state: "settled" }), "settled");
  assert.equal(deriveStatus({ transaction_state: "failed" }), "failed");
  assert.equal(deriveStatus({ transaction_state: "expired" }), "expired");
  assert.equal(
    deriveStatus({ transaction_state: "pending", expires_at: 2_000 }, { now: 1_000 }),
    "pending",
  );
  assert.equal(
    deriveStatus({ transaction_state: "pending", expires_at: 2_000 }, { now: 2_000 }),
    "expired",
  );
  // A string expiry is read as seconds; an unreadable one leaves the invoice pending.
  assert.equal(
    deriveStatus({ transaction_state: "pending", expires_at: "2000" }, { now: 2_500 }),
    "expired",
  );
  assert.equal(
    deriveStatus({ transaction_state: "pending", expires_at: "soon" }, { now: 2_500 }),
    "pending",
  );
  assert.equal(deriveStatus({}, { now: 1 }), "pending");
});

// `now` is compared against `expires_at`, which is unix SECONDS. Passing
// `Date.now()` — the obvious guess — used to make every invoice read as
// permanently expired, with no error and no warning: the types said `number`
// and the mistake only showed up as a UI that would not render a payable
// invoice. It throws at the call that made it instead.
test("a milliseconds `now` is rejected instead of expiring everything", () => {
  const invoice = { transaction_state: "pending", expires_at: 2_000_000_000 };
  assert.throws(() => deriveStatus(invoice, { now: Date.now() }), {
    name: "RangeError",
    message: /SECONDS/,
  });
  // The correct value works, and so does the seconds clock the option defaults to.
  assert.equal(deriveStatus(invoice, { now: Math.floor(Date.now() / 1000) }), "pending");
  assert.equal(deriveStatus(invoice), "pending");
});

// The same unit applies to the swap panel's countdown, which measures
// provider_expires_at against `now`.
test("createSwapDisplayModel rejects a milliseconds `now` too", async () => {
  const { createSwapDisplayModel } = await import("../packages/js/browser/src/headless.ts");
  const invoice = {
    invoice_id: "a".repeat(64),
    rail: "swap",
    transaction_state: "pending",
    workflow_state: "invoice_created",
    swap: {
      provider: "lsc",
      pay_in_asset: "USDT_TRON",
      provider_state: "awaiting_deposit",
      provider_expires_at: 2_000_000_000,
      deposit_address: "TXyz",
      deposit_amount: "10.00",
    },
  };
  assert.throws(() => createSwapDisplayModel(invoice, { now: Date.now() }), {
    name: "RangeError",
  });
  assert.equal(createSwapDisplayModel(invoice, { now: 1_000_000_000 })?.payInAsset, "USDT_TRON");
});
