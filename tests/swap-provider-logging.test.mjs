import assert from "node:assert/strict";
import test from "node:test";
import { createOpenReceive, formatLscUri } from "../packages/js/node/src/index.ts";
import { createLscSwapProvidersFromEnvironment } from "../packages/js/node/src/lsc-uri.ts";
import { createTestkitReceiveClient } from "../packages/js/testkit/src/index.ts";

const SAMPLE_RATES_XML = `<?xml version="1.0"?>
<rates>
  <item>
    <from>USDTTRC</from>
    <to>BTCLN</to>
    <in>315</in>
    <out>0.005</out>
    <amount>1000</amount>
    <minamount>10</minamount>
    <maxamount>11340</maxamount>
  </item>
  <item>
    <from>SOL</from>
    <to>BTCLN</to>
    <in>1</in>
    <out>0.001</out>
    <amount>100</amount>
    <minamount>0.01</minamount>
    <maxamount>50</maxamount>
  </item>
</rates>`;

const SAMPLE_CCIES = [
  { code: "USDTTRC", coin: "USDT", network: "TRC20", recv: true, send: true },
  { code: "SOL", coin: "SOL", network: "SOL", recv: true, send: true },
  { code: "BTCLN", coin: "BTC", network: "LIGHTNING", recv: false, send: true },
];

test("createOpenReceive logs FixedFloat API request/response traffic through the service logger", async () => {
  const events = [];
  const fetchCalls = [];
  const lscUri = formatLscUri({
    baseUrl: "https://swap.example",
    key: "test-key",
    secret: "test-secret-value-should-not-leak",
  });
  const mockFetch = async (url, init = {}) => {
    fetchCalls.push({ url: String(url), method: init.method ?? "GET" });
    if (String(url).endsWith("/rates/fixed.xml")) {
      return new Response(SAMPLE_RATES_XML, {
        status: 200,
        headers: { "content-type": "application/xml" },
      });
    }
    if (String(url).includes("/api/v2/ccies")) {
      return Response.json({ code: 0, msg: "OK", data: SAMPLE_CCIES });
    }
    return Response.json({ code: 1, msg: `unexpected ${url}` }, { status: 500 });
  };
  const providers = createLscSwapProvidersFromEnvironment(
    { LSC_URI_PRIMARY: lscUri },
    { fetch: mockFetch, now: () => 1_700_000_000 },
  );
  const service = await createOpenReceive({
    client: createTestkitReceiveClient({ now: () => 1_700_000_000 }),
    clock: () => 1_700_000_000,
    env: {},
    logger: (entry) => events.push(entry),
    swap: { providers },
  });

  try {
    const options = await service.listSwapOptions({ amountMsats: 20_000_000 });
    assert.equal(options.enabled, true);
    assert.ok(options.options.some((option) => option.payInAsset === "USDT_TRON"));

    const requestEvents = events.filter((entry) => entry.event === "swap.provider.request");
    const responseEvents = events.filter((entry) => entry.event === "swap.provider.response");
    assert.ok(
      requestEvents.some((entry) => entry.path === "ccies"),
      "expected logged /ccies request",
    );
    assert.ok(
      responseEvents.some((entry) => entry.path === "ccies" && entry.ok === true),
      "expected logged /ccies response",
    );
    assert.ok(
      requestEvents.some((entry) => entry.path === "rates/fixed.xml" && entry.level === "debug"),
      "expected logged rates XML request at debug",
    );
    assert.ok(
      responseEvents.some(
        (entry) =>
          entry.path === "rates/fixed.xml" &&
          entry.ok === true &&
          entry.pair_count === 2 &&
          entry.level === "debug",
      ),
      "expected logged rates XML response with pair_count at debug",
    );
    assert.ok(fetchCalls.some((call) => call.url.includes("/api/v2/ccies")));
    assert.ok(fetchCalls.some((call) => call.url.endsWith("/rates/fixed.xml")));

    const serialized = JSON.stringify(events);
    assert.doesNotMatch(serialized, /test-secret-value-should-not-leak/);
    assert.doesNotMatch(serialized, /X-API-KEY|X-API-SIGN/);
  } finally {
    await service.close();
  }
});

test("FixedFloat network failures still emit a swap.provider.response failure log", async () => {
  const events = [];
  const lscUri = formatLscUri({
    baseUrl: "https://swap.example",
    key: "test-key",
    secret: "test-secret",
  });
  const providers = createLscSwapProvidersFromEnvironment(
    { LSC_URI_PRIMARY: lscUri },
    {
      fetch: async () => {
        throw new TypeError("connect ECONNREFUSED");
      },
      now: () => 1_700_000_000,
    },
  );
  const service = await createOpenReceive({
    client: createTestkitReceiveClient({ now: () => 1_700_000_000 }),
    clock: () => 1_700_000_000,
    env: {},
    logger: (entry) => events.push(entry),
    swap: { providers },
  });

  try {
    const options = await service.listSwapOptions({ amountMsats: 20_000_000 });
    // Catalog failure soft-fails to unconfigured options rather than throwing.
    assert.equal(options.enabled, true);
    assert.ok(options.options.every((option) => option.provider === ""));

    assert.ok(
      events.some((entry) => entry.event === "swap.provider.request" && entry.path === "ccies"),
    );
    assert.ok(
      events.some(
        (entry) =>
          entry.event === "swap.provider.response" &&
          entry.path === "ccies" &&
          entry.ok === false &&
          entry.status === 0,
      ),
      "expected network failure response log",
    );
  } finally {
    await service.close();
  }
});
