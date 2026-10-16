import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  isOpenReceiveProvider,
  OPENRECEIVE_MEDUSA_ROUTE_PREFIX,
  openReceiveProviderId,
} from "../packages/js/medusa/src/index.ts";
import {
  currencyDigits,
  decimalAmount,
  exactOrigins,
  formatAmount,
  isPayableStatus,
  sessionIdOf,
  settledAttempt,
} from "../packages/js/medusa/src/logic.ts";

const packageDir = path.resolve(import.meta.dirname, "../packages/js/medusa");

// The provider id the guide's medusa-config produces, and the one test the
// storefront and the routes use to recognize the plugin's sessions.
test("the provider id and its test", () => {
  assert.equal(openReceiveProviderId(), "pp_openreceive_openreceive");
  assert.equal(openReceiveProviderId("lightning"), "pp_openreceive_lightning");
  assert.equal(isOpenReceiveProvider("pp_openreceive_openreceive"), true);
  assert.equal(isOpenReceiveProvider("pp_system_default"), false);
  assert.equal(isOpenReceiveProvider("pp_openreceivex_openreceive"), false);
  assert.equal(isOpenReceiveProvider(undefined), false);
  assert.equal(OPENRECEIVE_MEDUSA_ROUTE_PREFIX, "/store/openreceive");
});

// Medusa keeps amounts as decimals with more places than the currency has; a
// price must come out in the currency's minor units, rounded half up on the
// decimal string, never through a float.
test("a session's amount becomes a decimal string in the currency's minor units", () => {
  assert.equal(decimalAmount({ amount: 20 }, "EUR"), "20.00");
  assert.equal(decimalAmount({ raw_amount: { value: "10.335", precision: 20 } }, "USD"), "10.34");
  assert.equal(decimalAmount({ raw_amount: { value: "10.334" } }, "USD"), "10.33");
  assert.equal(decimalAmount({ raw_amount: { value: "0.005" }, amount: 99 }, "USD"), "0.01");
  assert.equal(decimalAmount({ amount: "1999.5" }, "JPY"), "2000");
  assert.equal(decimalAmount({ amount: 1.2345 }, "KWD"), "1.235");
  assert.equal(decimalAmount({ amount: 0 }, "USD"), null);
  assert.equal(decimalAmount({ amount: -5 }, "USD"), null);
  assert.equal(decimalAmount({ amount: "1e3" }, "USD"), null);
  assert.equal(decimalAmount({}, "USD"), null);
  assert.equal(currencyDigits("usd"), 2);
  assert.equal(currencyDigits("NOT-A-CURRENCY"), 2);
});

// Medusa's storeCors may hold patterns; OpenReceive lets a cross-site request
// through only from an exact origin. A trailing slash or a path never equals a
// browser's Origin header, so Medusa's own CORS refuses those entries too.
test("only exact origins from storeCors reach the cross-site allowlist", () => {
  assert.deepEqual(
    exactOrigins(
      "http://localhost:8000, https://shop.example.com,https://other.example.com/,/vercel\\.app$/,https://*.example.com,not a url,https://docs.medusajs.com/path",
    ),
    ["http://localhost:8000", "https://shop.example.com"],
  );
  assert.deepEqual(exactOrigins(undefined), []);
  assert.deepEqual(exactOrigins(""), []);
});

test("the session id comes from the session's data, then from Medusa's idempotency key", () => {
  assert.equal(
    sessionIdOf({ session_id: "payses_1" }, { idempotency_key: "payses_2" }),
    "payses_1",
  );
  assert.equal(sessionIdOf({}, { idempotency_key: "payses_2" }), "payses_2");
  assert.equal(sessionIdOf(undefined, undefined), undefined);
  assert.equal(sessionIdOf({ session_id: "" }, { idempotency_key: 7 }), undefined);
});

test("only an open session can be priced, and only a settled attempt counts as paid", () => {
  for (const status of ["pending", "requires_more", "error"])
    assert.equal(isPayableStatus(status), true);
  for (const status of ["authorized", "captured", "canceled", "pending_authorization", undefined]) {
    assert.equal(isPayableStatus(status), false);
  }
  const pending = { status: "pending", paymentHash: "a".repeat(64), paidAt: null };
  const settled = { status: "settled", paymentHash: "b".repeat(64), paidAt: 1_700_000_000 };
  assert.equal(settledAttempt([pending]), undefined);
  assert.equal(settledAttempt([pending, settled]), settled);
});

test("a refund's amount reads as a number in the log, whatever form Medusa passes", () => {
  assert.equal(formatAmount(5), "5");
  assert.equal(formatAmount("5.50"), "5.50");
  assert.equal(formatAmount({ numeric: 7 }), "7");
  assert.equal(formatAmount({ toJSON: () => 9 }), "9");
  assert.equal(formatAmount(undefined), "an amount");
});

// Medusa finds a plugin's routes, job and migration script only under
// .medusa/server/src, and the payment module loads the provider through the
// package export. The build writes there; these are its sources and wiring.
test("the plugin's files sit where Medusa loads them", () => {
  const manifest = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
  assert.equal(
    manifest.exports["./providers/openreceive"],
    "./.medusa/server/src/providers/openreceive/index.js",
  );
  assert.ok(manifest.files.includes(".medusa/server"));
  assert.ok(manifest.peerDependenciesMeta["@medusajs/framework"].optional);
  const config = readFileSync(path.join(packageDir, "tsup.config.ts"), "utf8");
  for (const entry of [
    "api/store/openreceive/[segment]/route",
    "api/store/openreceive/[segment]/[action]/route",
    "jobs/openreceive-reconcile",
    "migration-scripts/openreceive-payment-tables",
    "providers/openreceive/index",
  ]) {
    assert.ok(config.includes(`"${entry}"`), `tsup builds ${entry}`);
    assert.ok(
      existsSync(path.join(packageDir, "src/medusa", `${entry}.ts`)),
      `source for ${entry}`,
    );
  }
  assert.ok(config.includes('outDir: ".medusa/server/src"'));
});
