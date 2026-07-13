import assert from "node:assert/strict";
import test from "node:test";
import {
  convertAmountViaBtcRates,
  convertFiatViaBtcPrices,
  fiatValueToSats,
  formatBtcFromSats,
  formatDecimal,
  multiplyAmount,
  parseDecimal,
  satsToFiatValue,
  sumAmounts,
} from "../../packages/js/core/src/index.ts";
import { createHostOrderStore } from "../../packages/js/node/src/host-order-store.ts";
import {
  createHostConsoleLogger,
  createOpenReceiveConsoleLogger,
} from "../../packages/js/node/src/console-logger.ts";
import {
  createHostBrowserConsoleLogger,
  createOpenReceiveBrowserConsoleLogger,
} from "../../packages/js/browser/src/internal/console-logger.ts";
import { hostError, mapHostRouteError } from "../../packages/js/http/src/errors.ts";
import { OpenReceiveServiceError } from "../../packages/js/node/src/service/core-utils.ts";

test("core money math parses, multiplies, and sums decimals with bigint", () => {
  assert.deepEqual(parseDecimal("1.50"), { units: 150n, scale: 2 });
  assert.equal(formatDecimal(150n, 2), "1.50");
  assert.deepEqual(multiplyAmount({ currency: "USD", value: "1.50" }, 3), {
    currency: "USD",
    value: "4.50",
  });
  assert.deepEqual(
    sumAmounts([
      { currency: "USD", value: "1.50" },
      { currency: "USD", value: "2.25" },
    ]),
    { currency: "USD", value: "3.75" },
  );
});

test("core money math converts fiat ↔ sats and across BTC prices", () => {
  assert.equal(fiatValueToSats("1.50", "50000"), 3000n);
  assert.equal(satsToFiatValue(3000n, "50000"), "1.50");
  assert.equal(formatBtcFromSats(3000n), "0.00003");
  assert.equal(convertFiatViaBtcPrices("1.50", "50000", "2500000000"), "75000.00");
  assert.deepEqual(
    convertAmountViaBtcRates(
      { currency: "USD", value: "1.50" },
      "EUR",
      { bitcoin: { usd: "50000", eur: "46000" } },
    ),
    { currency: "EUR", value: "1.38" },
  );
});

test("createHostOrderStore persists amount authority for prepared orders", async () => {
  const meta = new Map();
  const store = {
    async getMeta(key) {
      const value = meta.get(key);
      return value === undefined ? undefined : { value, rev: 1 };
    },
    async casMeta(key, value, expectedRev) {
      if (expectedRev === null && meta.has(key)) {
        return { status: "conflict", row: { value: meta.get(key), rev: 1 } };
      }
      meta.set(key, value);
      return { status: "ok", row: { value, rev: 1 } };
    },
  };
  const orders = createHostOrderStore(store, { prefix: "demo_order:" });
  await orders.persist("ord_1", {
    amount: { currency: "USD", value: "9.99" },
    summary: { id: "ord_1" },
  });
  assert.deepEqual(await orders.read("ord_1"), {
    amount: { currency: "USD", value: "9.99" },
    summary: { id: "ord_1" },
  });
  assert.deepEqual(await orders.getAmount("ord_1"), {
    amount: { currency: "USD", value: "9.99" },
  });
  assert.equal(await orders.getAmount("missing"), null);
});

test("console loggers write OpenReceive and host events", () => {
  const lines = [];
  const fake = {
    debug: (...args) => lines.push(["debug", ...args]),
    info: (...args) => lines.push(["info", ...args]),
    warn: (...args) => lines.push(["warn", ...args]),
    error: (...args) => lines.push(["error", ...args]),
    log: (...args) => lines.push(["log", ...args]),
  };
  createOpenReceiveConsoleLogger({ prefix: "or", console: fake, minLevel: "info" })({
    level: "debug",
    event: "skip",
    message: "nope",
  });
  createOpenReceiveConsoleLogger({ prefix: "or", console: fake, minLevel: "info" })({
    level: "info",
    event: "checkout.created",
    message: "ok",
    order_id: "o1",
  });
  createHostConsoleLogger({ prefix: "host", console: fake })("ready", "up", { port: 3000 });
  assert.equal(lines.length, 2);
  assert.equal(lines[0][0], "info");
  assert.match(String(lines[0][1]), /\[or\] checkout\.created: ok/);
  assert.equal(lines[1][0], "log");
});

test("browser console loggers write checkout and host events", () => {
  const lines = [];
  const fake = {
    debug: (...args) => lines.push(["debug", ...args]),
    info: (...args) => lines.push(["info", ...args]),
    warn: (...args) => lines.push(["warn", ...args]),
    error: (...args) => lines.push(["error", ...args]),
    log: (...args) => lines.push(["log", ...args]),
  };
  createOpenReceiveBrowserConsoleLogger({ prefix: "or:client", console: fake })({
    level: "info",
    event: "checkout.poll",
    message: "tick",
  });
  createHostBrowserConsoleLogger({ prefix: "host:browser", console: fake })("ready", "mounted");
  assert.equal(lines.length, 2);
});

test("mapHostRouteError maps service and host errors", () => {
  const host = hostError("bad cart");
  assert.deepEqual(mapHostRouteError(host), {
    status: 400,
    body: { code: "INVALID_REQUEST", message: "bad cart", retryable: false },
  });
  const service = new OpenReceiveServiceError(404, {
    code: "NOT_FOUND",
    message: "missing",
  });
  assert.deepEqual(mapHostRouteError(service), {
    status: 404,
    body: { code: "NOT_FOUND", message: "missing" },
  });
  assert.equal(mapHostRouteError(new Error("boom")), null);
});
