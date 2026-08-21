import assert from "node:assert/strict";
import test from "node:test";
import {
  createHostConsoleLogger,
  createOpenReceiveConsoleLogger,
  parseOpenReceiveLogLevel,
  readOpenReceiveLogLevelFromEnvironment,
  resolveOpenReceiveLogLevel,
} from "../packages/js/node/src/index.ts";
import {
  createOpenReceiveBrowserConsoleLogger,
  parseOpenReceiveBrowserLogLevel,
  readOpenReceiveBrowserLogLevelFromEnvironment,
} from "../packages/js/browser/src/index.ts";

test("parseOpenReceiveLogLevel accepts DEBUG/INFO/WARN/ERROR case-insensitively", () => {
  assert.equal(parseOpenReceiveLogLevel("DEBUG"), "debug");
  assert.equal(parseOpenReceiveLogLevel("info"), "info");
  assert.equal(parseOpenReceiveLogLevel("Warn"), "warn");
  assert.equal(parseOpenReceiveLogLevel("WARNING"), "warn");
  assert.equal(parseOpenReceiveLogLevel("ERROR"), "error");
  assert.equal(parseOpenReceiveLogLevel(""), undefined);
  assert.equal(parseOpenReceiveLogLevel("trace"), undefined);
  assert.equal(resolveOpenReceiveLogLevel(undefined), "info");
  assert.equal(resolveOpenReceiveLogLevel("nope"), "info");
});

test("readOpenReceiveLogLevelFromEnvironment defaults to info", () => {
  assert.equal(readOpenReceiveLogLevelFromEnvironment({}), "info");
  assert.equal(readOpenReceiveLogLevelFromEnvironment({ LOG_LEVEL: "DEBUG" }), "debug");
  assert.equal(readOpenReceiveLogLevelFromEnvironment({ LOG_LEVEL: " warn " }), "warn");
});

test("createOpenReceiveConsoleLogger emits timestamped LEVEL-prefixed lines and filters by minLevel", () => {
  const lines = [];
  const logger = createOpenReceiveConsoleLogger({
    prefix: "openreceive:test",
    minLevel: "info",
    now: () => new Date("2026-07-30T00:01:58.332Z"),
    console: {
      debug: (...args) => lines.push({ method: "debug", args }),
      info: (...args) => lines.push({ method: "info", args }),
      warn: (...args) => lines.push({ method: "warn", args }),
      error: (...args) => lines.push({ method: "error", args }),
      log: (...args) => lines.push({ method: "log", args }),
    },
  });

  logger({
    level: "debug",
    event: "payment.check.requested",
    message: "hidden at info",
    payment_hash: "abc",
  });
  logger({
    level: "info",
    event: "payment.check.completed",
    message: "NWC payment settlement poll completed.",
    status: "settled",
  });

  assert.equal(lines.length, 1);
  assert.equal(lines[0].method, "info");
  assert.equal(
    lines[0].args[0],
    "[2026-07-30T00:01:58.332Z] INFO [openreceive:test] payment.check.completed: NWC payment settlement poll completed.",
  );
  assert.deepEqual(lines[0].args[1], { status: "settled" });
});

test("createHostConsoleLogger includes timestamps and honors minLevel", () => {
  const lines = [];
  const log = createHostConsoleLogger({
    prefix: "hello-fruit:test:server",
    minLevel: "warn",
    now: () => new Date("2026-07-30T00:01:58.332Z"),
    console: {
      debug: (...args) => lines.push(args),
      info: (...args) => lines.push(args),
      warn: (...args) => lines.push(args),
      error: (...args) => lines.push(args),
      log: (...args) => lines.push(args),
    },
  });

  log("cart.updated", "ignored at warn");
  log("openreceive.on_paid", "Checkout settled.", { orderId: "o1" }, "warn");

  assert.equal(lines.length, 1);
  assert.equal(
    lines[0][0],
    "[2026-07-30T00:01:58.332Z] WARN [hello-fruit:test:server] openreceive.on_paid: Checkout settled.",
  );
  assert.deepEqual(lines[0][1], { orderId: "o1" });
});

test("createOpenReceive attaches a console logger when the host omits logger", async () => {
  const lines = [];
  const previousLog = console.info;
  console.info = (...args) => lines.push(args);
  try {
    const { createOpenReceive } = await import("../packages/js/node/src/index.ts");
    const { createTestkitReceiveClient } = await import("../packages/js/testkit/src/index.ts");
    const now = 1_700_000_100;
    const wallet = createTestkitReceiveClient({ now: () => now });
    const created = await wallet.makeInvoice({ amount_msats: 4_000_000n });
    wallet.settleInvoice({ payment_hash: created.payment_hash }, { settled_at: now });

    const service = await createOpenReceive({
      client: wallet,
      clock: () => now,
      env: {},
      logging: { enabled: false },
    });
    try {
      await service.checkPayment({
        paymentHash: created.payment_hash,
        createdAt: created.created_at,
      });
    } finally {
      await service.close();
    }

    assert.ok(
      lines.some(
        (args) =>
          typeof args[0] === "string" &&
          args[0].includes("payment.check.completed") &&
          args[0].includes("[openreceive]"),
      ),
      "expected default console logger to emit payment.check.completed",
    );
  } finally {
    console.info = previousLog;
  }
});

test("browser console logger reads runtime __OPENRECEIVE_LOG_LEVEL__ and formats timestamps", () => {
  const previous = globalThis.__OPENRECEIVE_LOG_LEVEL__;
  const lines = [];
  try {
    globalThis.__OPENRECEIVE_LOG_LEVEL__ = "DEBUG";
    assert.equal(parseOpenReceiveBrowserLogLevel("ERROR"), "error");
    assert.equal(readOpenReceiveBrowserLogLevelFromEnvironment(), "debug");

    const logger = createOpenReceiveBrowserConsoleLogger({
      prefix: "openreceive:test:client",
      now: () => new Date("2026-07-30T00:01:58.332Z"),
      console: {
        debug: (...args) => lines.push({ method: "debug", args }),
        info: (...args) => lines.push({ method: "info", args }),
        warn: (...args) => lines.push({ method: "warn", args }),
        error: (...args) => lines.push({ method: "error", args }),
        log: (...args) => lines.push({ method: "log", args }),
      },
    });

    logger({
      level: "debug",
      event: "checkout.state.refreshed",
      message: "Refreshed checkout state from order status.",
      order_id: "o1",
    });

    assert.equal(lines.length, 1);
    assert.equal(lines[0].method, "debug");
    assert.equal(
      lines[0].args[0],
      "[2026-07-30T00:01:58.332Z] DEBUG [openreceive:test:client] checkout.state.refreshed: Refreshed checkout state from order status.",
    );
  } finally {
    if (previous === undefined) {
      delete globalThis.__OPENRECEIVE_LOG_LEVEL__;
    } else {
      globalThis.__OPENRECEIVE_LOG_LEVEL__ = previous;
    }
  }
});
