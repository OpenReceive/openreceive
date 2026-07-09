import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import express from "express";
import { InMemoryInvoiceKvStore, StaticPriceProvider } from "../../packages/js/core/src/index.ts";
import { openReceiveExpress } from "../../packages/js/express/src/index.ts";
import { openReceiveNextHandlers } from "../../packages/js/next/src/index.ts";
import { createOpenReceive } from "../../packages/js/node/src/index.ts";
import { TestkitReceiveClient } from "../../packages/js/testkit/src/index.ts";

// HTTP golden parity across adapters (spec PART 9): the same golden vectors that pin the
// framework-agnostic @openreceive/http handler must produce byte-equal status + error_code when
// served through the Express adapter and the Next.js adapter. This is what keeps the adapters from
// silently drifting from the shared contract (and, with the Ruby engine, from each other).

const GOLDEN_DIR = fileURLToPath(new URL("../../spec/test-vectors/http-golden/", import.meta.url));

function loadGoldenVectors() {
  return readdirSync(GOLDEN_DIR)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => ({ file, ...JSON.parse(readFileSync(`${GOLDEN_DIR}${file}`, "utf8")) }));
}

async function makeService() {
  return await createOpenReceive({
    configPath: false,
    client: new TestkitReceiveClient(),
    store: new InMemoryInvoiceKvStore(),
    namespace: "adapter_parity",
    clock: () => 1000,
    priceProviders: [new StaticPriceProvider()],
    swap: { providers: [] },
  });
}

// Default pricing for adapter parity (golden vectors do not exercise create pricing).
const defaultResolveOrder = () => ({ sats: 200 });

// The golden vectors were authored against the DEFAULT authorize policy (no authorize hook), which
// warns on construction. Silence that noise here.
function withSilencedWarnings(fn) {
  const original = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = original;
  }
}

async function assertMatchesExpected(status, bodyText, vector) {
  assert.equal(status, vector.expected.status, `${vector.file}: status`);
  if (vector.expected.error_code !== undefined) {
    let parsed;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      assert.fail(`${vector.file}: expected a JSON error body, got: ${bodyText}`);
    }
    assert.equal(parsed.code, vector.expected.error_code, `${vector.file}: error_code`);
  }
}

test("Express adapter serves the HTTP golden vectors identically", async () => {
  const service = await makeService();
  const app = express();
  app.use(express.json());
  withSilencedWarnings(() => {
    app.use(openReceiveExpress({ service, resolveOrder: defaultResolveOrder }));
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    for (const vector of loadGoldenVectors()) {
      const { method, path, headers, body } = vector.request;
      const init = { method, headers: { ...(headers ?? {}) } };
      if (body !== undefined) {
        init.headers["content-type"] = init.headers["content-type"] ?? "application/json";
        init.body = JSON.stringify(body);
      }
      const response = await fetch(`${base}${path}`, init);
      const text = await response.text();
      await assertMatchesExpected(response.status, text, vector);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await service.close();
  }
});

test("Next.js adapter serves the HTTP golden vectors identically", async () => {
  const service = await makeService();
  const { GET, POST } = withSilencedWarnings(() =>
    openReceiveNextHandlers({ service, resolveOrder: defaultResolveOrder }),
  );

  try {
    for (const vector of loadGoldenVectors()) {
      const { method, path, headers, body } = vector.request;
      const init = { method, headers: { ...(headers ?? {}) } };
      if (body !== undefined) {
        init.headers["content-type"] = init.headers["content-type"] ?? "application/json";
        init.body = JSON.stringify(body);
      }
      const request = new Request(`http://openreceive.test${path}`, init);
      const route = method.toUpperCase() === "GET" ? GET : POST;
      const response = await route(request);
      const text = await response.text();
      await assertMatchesExpected(response.status, text, vector);
    }
  } finally {
    await service.close();
  }
});
