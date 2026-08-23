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
