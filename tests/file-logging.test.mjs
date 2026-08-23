import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  attachLogging,
  createFileLogger,
  createFileLoggerFromConfig,
  OPENRECEIVE_LOGGING_DEFAULTS,
} from "../packages/js/node/src/service/file-logger.ts";

function scratchDirectory(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "openreceive-file-logging-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// A library must not start writing into whatever directory the host process
// happens to run from; file logging is a deliberate host decision.
test("file logging is off until the host opts in", () => {
  assert.equal(OPENRECEIVE_LOGGING_DEFAULTS.enabled, false);
  assert.equal(createFileLoggerFromConfig(undefined), undefined);
  assert.equal(createFileLoggerFromConfig({}), undefined);
  assert.equal(createFileLoggerFromConfig({ enabled: false }), undefined);
  assert.equal(createFileLoggerFromConfig({ directory: "./nope" }), undefined);
});

test("attachLogging creates no log directory by default", () => {
  const before = existsSync("logs");
  const options = attachLogging({});
  assert.equal(typeof options.logger, "function");
  // Below the console minimum, so this only exercises the sink composition.
  options.logger({ level: "debug", event: "boot", message: "no file sink attached" });
  assert.equal(existsSync("logs"), before);
});

test("an opted-in file logger buffers, then flushes every line to disk", async (t) => {
  const directory = scratchDirectory(t);
  const logger = createFileLoggerFromConfig({
    enabled: true,
    directory,
    filename: "openreceive.log",
    level: "info",
  });
  assert.notEqual(logger, undefined);
  const logPath = path.join(directory, "openreceive.log");

  logger({ level: "info", event: "payment.check.completed", message: "first", status: "settled" });
  logger({ level: "debug", event: "ignored.below.min.level", message: "hidden" });
  logger({ level: "warn", event: "reconcile.retry", message: "second" });
  // Writes are buffered: the line is not on disk synchronously.
  assert.equal(existsSync(logPath), false);

  await logger.flush();
  const lines = readFileSync(logPath, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(
    lines.map((line) => line.event),
    ["payment.check.completed", "reconcile.retry"],
  );
  assert.equal(lines[0].status, "settled");
  assert.equal(typeof lines[0].timestamp, "string");
});

test("the file logger rotates by size and keeps the configured archive count", async (t) => {
  const directory = scratchDirectory(t);
  const logPath = path.join(directory, "rotate.log");
  const logger = createFileLogger({
    directory,
    filename: "rotate.log",
    maxFileSizeBytes: 1024,
    maxFiles: 2,
    minLevel: "info",
  });
  for (let index = 0; index < 40; index += 1) {
    logger({ level: "info", event: "bulk", message: "x".repeat(100), index });
    // Flushing per line exercises the rotation path between batches too.
    await logger.flush();
  }
  assert.ok(readFileSync(logPath, "utf8").length <= 1024 + 200);
  assert.ok(existsSync(`${logPath}.1`));
  assert.equal(existsSync(`${logPath}.2`), false);
});
