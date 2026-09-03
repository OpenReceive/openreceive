import assert from "node:assert/strict";
import test from "node:test";
import { createAppConsoleLogger } from "../packages/js/node/src/index.ts";
import { createConsoleLogger } from "../packages/js/node/src/console-logger.ts";
import {
  parseLogLevel,
  readLogLevelFromEnvironment,
  resolveLogLevel,
} from "../packages/js/node/src/log-level.ts";
import { createBrowserConsoleLogger } from "../packages/js/browser/src/internal/console-logger.ts";
import {
  parseBrowserLogLevel,
  readBrowserLogLevelFromEnvironment,
} from "../packages/js/browser/src/internal/log-level.ts";

test("parseLogLevel accepts DEBUG/INFO/WARN/ERROR case-insensitively", () => {
  assert.equal(parseLogLevel("DEBUG"), "debug");
  assert.equal(parseLogLevel("info"), "info");
  assert.equal(parseLogLevel("Warn"), "warn");
  assert.equal(parseLogLevel("WARNING"), "warn");
  assert.equal(parseLogLevel("ERROR"), "error");
  assert.equal(parseLogLevel(""), undefined);
  assert.equal(parseLogLevel("trace"), undefined);
  assert.equal(resolveLogLevel(undefined), "info");
  assert.equal(resolveLogLevel("nope"), "info");
});

test("readLogLevelFromEnvironment defaults to info", () => {
  assert.equal(readLogLevelFromEnvironment({}), "info");
  assert.equal(readLogLevelFromEnvironment({ LOG_LEVEL: "DEBUG" }), "debug");
  assert.equal(readLogLevelFromEnvironment({ LOG_LEVEL: " warn " }), "warn");
});

test("createConsoleLogger emits timestamped LEVEL-prefixed lines and filters by minLevel", () => {
  const lines = [];
  const logger = createConsoleLogger({
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
  // One console argument, one line: fields ride inline as key=value. Passed as
  // a second argument, Node printed any object past ~70 characters across
  // several lines — a reconcile pass was ten lines on every status poll.
  assert.deepEqual(lines[0].args, [
    "[2026-07-30T00:01:58.332Z] INFO [openreceive:test] payment.check.completed: NWC payment settlement poll completed. status=settled",
  ]);
});

test("createConsoleLogger keeps every field on the one line", () => {
  const lines = [];
  const logger = createConsoleLogger({
    prefix: "openreceive",
    minLevel: "info",
    now: () => new Date("2026-07-30T00:01:58.332Z"),
    console: { info: (...args) => lines.push(args) },
  });
  logger({
    level: "info",
    event: "payment.reconcile.completed",
    message: "1 pending",
    attempt_count: 1,
    settled_count: 0,
    pending_count: 1,
    walks: 2,
    window: "1788447941..1788448061",
    error_message: "rate limit: try again",
    nested: { code: "E_RATE", retryable: true },
    tags: ["a", "b"],
    skipped: undefined,
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].length, 1);
  assert.equal(
    lines[0][0],
    "[2026-07-30T00:01:58.332Z] INFO [openreceive] payment.reconcile.completed: 1 pending " +
      "attempt_count=1 settled_count=0 pending_count=1 walks=2 window=1788447941..1788448061 " +
      `error_message="rate limit: try again" nested={ code: 'E_RATE', retryable: true } tags=[ 'a', 'b' ]`,
  );
  assert.doesNotMatch(lines[0][0], /\n/);
});

test("createAppConsoleLogger includes timestamps and honors minLevel", () => {
  const lines = [];
  const log = createAppConsoleLogger({
    prefix: "buttons:test:server",
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
  log("openreceive.on_paid", "Checkout settled.", { reference: "o1" }, "warn");

  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], [
    "[2026-07-30T00:01:58.332Z] WARN [buttons:test:server] openreceive.on_paid: Checkout settled. reference=o1",
  ]);
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
      await service.reconcilePayments({
        attempts: [{ paymentHash: created.payment_hash, createdAt: created.created_at }],
      });
    } finally {
      await service.close();
    }

    assert.ok(
      lines.some(
        (args) =>
          typeof args[0] === "string" &&
          args[0].includes("payment.reconcile.completed") &&
          args[0].includes("[openreceive]"),
      ),
      "expected default console logger to emit payment.reconcile.completed",
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
    assert.equal(parseBrowserLogLevel("ERROR"), "error");
    assert.equal(readBrowserLogLevelFromEnvironment(), "debug");

    const logger = createBrowserConsoleLogger({
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
      reference: "o1",
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
