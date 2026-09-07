import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("../tools/ci/parallel.mjs", import.meta.url));

function fixture(t, jobs, scripts) {
  const directory = mkdtempSync(path.join(tmpdir(), "ci-parallel-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "npm"), '#!/bin/sh\nexec "$TEST_NODE" "$TEST_PROBE" "$@"\n', {
    mode: 0o700,
  });
  const probe = path.join(directory, "probe.cjs");
  const events = path.join(directory, "events.jsonl");
  writeFileSync(
    probe,
    `
const { appendFileSync } = require('node:fs');
const script = process.argv[3];
const emit = (event) => appendFileSync(process.env.TEST_EVENTS, JSON.stringify({script,event}) + '\\n');
emit('start');
setTimeout(() => { emit('end'); process.exit(script === 'fail' ? 17 : 0); }, 100);
`,
  );
  const result = spawnSync(process.execPath, [runner, ...scripts], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TEST_NODE: process.execPath,
      TEST_PROBE: probe,
      TEST_EVENTS: events,
      OPENRECEIVE_CI_JOBS: jobs,
      TMPDIR: directory,
    },
  });
  return { result, events };
}

test("parallel checks respect the worker limit, finish every lane, and preserve failures", (t) => {
  const { result, events } = fixture(t, "2", ["first", "fail", "last"]);
  assert.equal(result.status, 1, result.stderr);
  let active = 0;
  let peak = 0;
  const ended = [];
  for (const { script, event } of readFileSync(events, "utf8").trim().split("\n").map(JSON.parse)) {
    active += event === "start" ? 1 : -1;
    peak = Math.max(peak, active);
    if (event === "end") ended.push(script);
  }
  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.deepEqual(ended.sort(), ["fail", "first", "last"]);
  assert.match(result.stdout, /FAIL fail/);
});

test("one worker runs a successful serial gate", (t) => {
  const { result, events } = fixture(t, "1", ["first", "last"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    readFileSync(events, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse)
      .map(({ event }) => event),
    ["start", "end", "start", "end"],
  );
});

test("invalid concurrency fails before starting checks", (t) => {
  const { result, events } = fixture(t, "0", ["first"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /positive integer/);
  assert.throws(() => readFileSync(events), { code: "ENOENT" });
});
