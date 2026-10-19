import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  OPENRECEIVE_VENDURE_HANDLER_CODE,
  OPENRECEIVE_VENDURE_ORDER_ROUTE,
  OPENRECEIVE_VENDURE_ROUTE_PREFIX,
  orderReference,
  parseOrderReference,
} from "../packages/js/vendure/src/index.ts";
import {
  amountDue,
  currencyDigits,
  decimalAmount,
  exactOrigins,
  isOpenOrderState,
  settledAttempt,
  sqlDialect,
} from "../packages/js/vendure/src/logic.ts";

const packageDir = path.resolve(import.meta.dirname, "../packages/js/vendure");

test("the handler code and the routes the storefront calls", () => {
  assert.equal(OPENRECEIVE_VENDURE_HANDLER_CODE, "openreceive");
  assert.equal(OPENRECEIVE_VENDURE_ROUTE_PREFIX, "/openreceive");
  assert.equal(OPENRECEIVE_VENDURE_ORDER_ROUTE, "/openreceive/order");
});

// A reference names an order and the price it was made for. When the cart
// changes, the amount due changes and so does the reference, so a checkout
// never resumes an invoice for an old total.
test("a reference is the order code, its currency and the amount due", () => {
  assert.equal(
    orderReference({ code: "K7HJ3Z9P2LQX4M8N", currency: "usd", due: 1200 }),
    "K7HJ3Z9P2LQX4M8N:USD:1200",
  );
  assert.deepEqual(parseOrderReference("K7HJ3Z9P2LQX4M8N:USD:1200"), {
    code: "K7HJ3Z9P2LQX4M8N",
    currency: "USD",
    due: 1200,
  });
  // A custom order code may itself hold a colon; the last two parts are the price.
  assert.deepEqual(parseOrderReference("2026:00042:EUR:999"), {
    code: "2026:00042",
    currency: "EUR",
    due: 999,
  });
  for (const bad of [
    "K7HJ3Z9P2LQX4M8N",
    "K7:USD:0",
    "K7:usd:12",
    "K7:USD:-5",
    "K7:USD:1.5",
    ":USD:5",
    "K7:USD:9999999999999999",
  ]) {
    assert.equal(parseOrderReference(bad), undefined, bad);
  }
});

// Vendure stores money as integers at the MoneyStrategy's precision (2 by
// default, whatever the currency). OpenReceive prices in the currency's own
// minor units, rounding half up on the digits, never through a float.
test("a stored amount becomes a decimal string in the currency's minor units", () => {
  assert.equal(decimalAmount(1200, 2, "USD"), "12.00");
  assert.equal(decimalAmount(7, 2, "USD"), "0.07");
  assert.equal(decimalAmount(100050, 2, "JPY"), "1001");
  assert.equal(decimalAmount(100049, 2, "JPY"), "1000");
  assert.equal(decimalAmount(12345, 3, "USD"), "12.35");
  assert.equal(decimalAmount(12345, 3, "KWD"), "12.345");
  assert.equal(decimalAmount(500, 0, "EUR"), "500.00");
  assert.equal(decimalAmount(0, 2, "USD"), null);
  assert.equal(decimalAmount(-5, 2, "USD"), null);
  assert.equal(decimalAmount(1.5, 2, "USD"), null);
  assert.equal(decimalAmount(4, 2, "JPY"), null);
  assert.equal(currencyDigits("jpy"), 0);
  assert.equal(currencyDigits("NOT-A-CURRENCY"), 2);
});

test("what is due counts authorized and settled payments, net of settled refunds", () => {
  assert.equal(amountDue({ totalWithTax: 1200 }), 1200);
  assert.equal(
    amountDue({
      totalWithTax: 3000,
      payments: [
        {
          state: "Settled",
          amount: 1000,
          refunds: [
            { state: "Settled", total: 200 },
            { state: "Pending", total: 500 },
          ],
        },
        { state: "Authorized", amount: 500 },
        { state: "Declined", amount: 3000 },
        { state: "Cancelled", amount: 3000 },
        { state: "Created", amount: 3000 },
      ],
    }),
    1700,
  );
});

test("only orders still at checkout are open", () => {
  for (const state of ["AddingItems", "ArrangingPayment"])
    assert.equal(isOpenOrderState(state), true);
  for (const state of ["PaymentSettled", "PaymentAuthorized", "Cancelled", "Draft", undefined]) {
    assert.equal(isOpenOrderState(state), false);
  }
});

// Vendure's cors.origin may be true (any origin, the dev setting), a pattern
// or a function; OpenReceive lets a cross-site request through only from an
// exact origin.
test("only exact origins from Vendure's cors setting reach the cross-site allowlist", () => {
  assert.deepEqual(
    exactOrigins({
      origin: [
        "https://shop.example.com",
        "http://localhost:3001",
        "https://other.example.com/",
        /vercel\.app$/,
        "https://*.example.com",
        "not a url",
      ],
    }),
    ["https://shop.example.com", "http://localhost:3001"],
  );
  assert.deepEqual(exactOrigins({ origin: "https://a.example.com, https://b.example.com" }), [
    "https://a.example.com",
    "https://b.example.com",
  ]);
  assert.deepEqual(exactOrigins({ origin: true }), []);
  assert.deepEqual(exactOrigins(true), []);
  assert.deepEqual(exactOrigins(undefined), []);
});

test("the plugin keeps payments in PostgreSQL, MySQL or MariaDB, not SQLite", () => {
  assert.equal(sqlDialect("postgres"), "postgres");
  assert.equal(sqlDialect("mysql"), "mysql");
  assert.equal(sqlDialect("mariadb"), "mysql");
  for (const type of ["better-sqlite3", "sqljs", "sqlite", undefined])
    assert.equal(sqlDialect(type), undefined);
});

test("only a settled attempt counts as paid", () => {
  const pending = { status: "pending", paymentHash: "a".repeat(64), paidAt: null };
  const settled = { status: "settled", paymentHash: "b".repeat(64), paidAt: 1_700_000_000 };
  assert.equal(settledAttempt([pending]), undefined);
  assert.equal(settledAttempt([pending, settled]), settled);
});

// vendure-config imports the plugin from @openreceive/vendure/plugin, which a
// CommonJS Vendure project require()s (Node 22.12 loads the ESM build): the
// exports must carry a "default" condition, not only "import".
test("the plugin entry is exported for require() and import", () => {
  const manifest = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
  assert.equal(manifest.exports["./plugin"].default, "./dist/plugin.js");
  assert.equal(manifest.exports["."].default, "./dist/index.js");
  assert.deepEqual(manifest.typesVersions["*"].plugin, ["./dist/plugin.d.ts"]);
  assert.ok(manifest.peerDependenciesMeta["@vendure/core"].optional);
  const config = readFileSync(path.join(packageDir, "tsup.config.ts"), "utf8");
  for (const entry of ["index", "plugin", "enable-openreceive"]) {
    assert.ok(config.includes(`${entry === "enable-openreceive" ? `"${entry}"` : entry}:`), entry);
  }
});
