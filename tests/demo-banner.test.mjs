import assert from "node:assert/strict";
import test from "node:test";

import { formatDemoBanner, waitForHttp } from "../tools/shared/demo-banner.mjs";

// The address of a running demo is the one thing the launcher must not let
// docker compose bury. The banner is a box the eye finds, and it is drawn
// again when the port answers (see tools/run-demo.mjs).
test("the demo banner boxes the address on equal-width rows, plain when not on a TTY", () => {
  const banner = formatDemoBanner({
    title: "Buy a Button — Django + Postgres is ready",
    url: "http://localhost:3006",
    lines: ["Open this address in your browser."],
  });
  const rows = banner.split("\n");
  assert.ok(rows.length >= 6, "title, blank, url, blank, hint, plus the frame");
  assert.ok(
    rows.every((row) => [...row].length === [...rows[0]].length),
    "every row is the same width",
  );
  assert.match(rows[0], /^╔═+╗$/);
  assert.match(rows.at(-1), /^╚═+╝$/);
  assert.ok(banner.includes("║ http://localhost:3006"));
  assert.ok(!banner.includes("\x1b["), "no escape codes unless asked for color");
});

test("the colored banner is the plain banner wrapped in bold green", () => {
  const input = { title: "T", url: "http://localhost:3000" };
  const plain = formatDemoBanner(input);
  const colored = formatDemoBanner({ ...input, color: true });
  assert.equal(colored, `\x1b[1;32m${plain}\x1b[0m`);
});

test("waitForHttp answers true on the first HTTP response of any status, retrying refusals", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls < 3) throw new TypeError("fetch failed: ECONNREFUSED");
    return new Response("not found", { status: 404 });
  };
  const answered = await waitForHttp({
    url: "http://localhost:3006",
    fetchImpl,
    intervalMs: 1,
    sleep: async () => undefined,
  });
  assert.equal(answered, true);
  assert.equal(calls, 3);
});

test("waitForHttp gives up on abort and on the deadline", async () => {
  const refuse = async () => {
    throw new TypeError("fetch failed");
  };
  const controller = new AbortController();
  const aborted = waitForHttp({
    url: "http://localhost:3006",
    fetchImpl: refuse,
    intervalMs: 1,
    sleep: async () => controller.abort(),
    signal: controller.signal,
  });
  assert.equal(await aborted, false);

  const timedOut = await waitForHttp({
    url: "http://localhost:3006",
    fetchImpl: refuse,
    intervalMs: 1,
    timeoutMs: 0,
    sleep: async () => undefined,
  });
  assert.equal(timedOut, false);
});
