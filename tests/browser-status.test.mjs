import assert from "node:assert/strict";
import test from "node:test";

import { status } from "../packages/js/browser/src/index.ts";

// status() follows the server's transaction_state verdict. It never re-derives
// settlement from a timestamp: the settlement rule lives in @openreceive/core
// and is not duplicated in the browser.
test("status follows transaction_state and the expiry clock", () => {
  assert.equal(status({ transaction_state: "settled" }), "settled");
  assert.equal(status({ transaction_state: "failed" }), "failed");
  assert.equal(status({ transaction_state: "expired" }), "expired");
  assert.equal(status({ transaction_state: "pending", expires_at: 2_000 }, { now: 1_000 }), "pending");
  assert.equal(status({ transaction_state: "pending", expires_at: 2_000 }, { now: 2_000 }), "expired");
  // A string expiry is read as seconds; an unreadable one leaves the invoice pending.
  assert.equal(status({ transaction_state: "pending", expires_at: "2000" }, { now: 2_500 }), "expired");
  assert.equal(status({ transaction_state: "pending", expires_at: "soon" }, { now: 2_500 }), "pending");
  assert.equal(status({}, { now: 1 }), "pending");
});
