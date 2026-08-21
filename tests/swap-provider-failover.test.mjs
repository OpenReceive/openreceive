import assert from "node:assert/strict";
import test from "node:test";
import { createOpenReceive, formatLscUri } from "../packages/js/node/src/index.ts";
import { createLscSwapProvidersFromEnvironment } from "../packages/js/node/src/lsc-uri.ts";
import { createTestkitReceiveClient } from "../packages/js/testkit/src/index.ts";

const PRIMARY_URI = formatLscUri({
  baseUrl: "https://primary.example",
  key: "primary-key",
  secret: "primary-secret",
});
const BACKUP_URI = formatLscUri({
  baseUrl: "https://backup.example",
  key: "backup-key",
  secret: "backup-secret",
});

const SAMPLE_CCIES = [
  { code: "USDTTRC", coin: "USDT", network: "TRC20", recv: true, send: true },
  { code: "SOL", coin: "SOL", network: "SOL", recv: true, send: true },
  { code: "BTCLN", coin: "BTC", network: "LIGHTNING", recv: false, send: true },
];

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
  <item>
    <from>DOGE</from>
    <to>BTC</to>
    <in>1</in>
    <out>0.000001</out>
    <amount>100000</amount>
    <minamount>10</minamount>
    <maxamount>500000</maxamount>
  </item>
  <item>
    <from>ETH</from>
    <to>USDT</to>
    <in>1</in>
    <out>3000</out>
    <amount>10</amount>
    <minamount>0.01</minamount>
    <maxamount>5</maxamount>
  </item>
</rates>`;

function mockProviderFetch(input = {}) {
  const { hostBehavior = {}, fetchCalls = [] } = input;
  return async (url, init = {}) => {
    const href = String(url);
    fetchCalls.push({ url: href, method: init.method ?? "GET" });
    const host = new URL(href).host;
    const behavior = hostBehavior[host] ?? { mode: "ok" };
    if (behavior.mode === "down") {
      throw new TypeError(`connect ECONNREFUSED ${host}`);
    }
    if (href.endsWith("/rates/fixed.xml")) {
      return new Response(behavior.ratesXml ?? SAMPLE_RATES_XML, {
        status: 200,
        headers: { "content-type": "application/xml" },
      });
    }
    if (href.includes("/api/v2/ccies")) {
      return Response.json({ code: 0, msg: "OK", data: behavior.ccies ?? SAMPLE_CCIES });
    }
    return Response.json({ code: 1, msg: `unexpected ${href}` }, { status: 500 });
  };
}

async function createService(input) {
  const fetchCalls = [];
  const events = [];
  const providers = createLscSwapProvidersFromEnvironment(
    {
      LSC_URI_PRIMARY: PRIMARY_URI,
      LSC_URI_BACKUP: BACKUP_URI,
    },
    {
      fetch: mockProviderFetch({ hostBehavior: input.hostBehavior, fetchCalls }),
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
  return { service, fetchCalls, events };
}

test("listSwapOptions uses only primary while primary is healthy", async () => {
  const { service, fetchCalls, events } = await createService({
    hostBehavior: {
      "primary.example": { mode: "ok" },
      "backup.example": { mode: "ok" },
    },
  });
  try {
    const options = await service.listSwapOptions({ amountMsats: 20_000_000 });
    assert.equal(options.enabled, true);
    const usdt = options.options.find((option) => option.payInAsset === "USDT_TRON");
    assert.equal(usdt?.provider, "primary-example");
    assert.equal(
      fetchCalls.some((call) => call.url.includes("backup.example")),
      false,
      "backup must not be contacted while primary is healthy",
    );
    assert.equal(
      events.some((entry) => entry.event === "swap.provider.failover"),
      false,
    );
    const ratesResponse = events.find(
      (entry) =>
        entry.event === "swap.provider.response" &&
        entry.path === "rates/fixed.xml" &&
        entry.ok === true,
    );
    // DOGE→BTC and ETH→USDT are ignored; only OpenReceive LN pairs remain.
    assert.equal(ratesResponse?.pair_count, 2);
  } finally {
    await service.close();
  }
});

test("listSwapOptions fails over to backup only when primary is down", async () => {
  const { service, fetchCalls, events } = await createService({
    hostBehavior: {
      "primary.example": { mode: "down" },
      "backup.example": { mode: "ok" },
    },
  });
  try {
    const options = await service.listSwapOptions({ amountMsats: 20_000_000 });
    const usdt = options.options.find((option) => option.payInAsset === "USDT_TRON");
    assert.equal(usdt?.provider, "backup-example");
    assert.ok(fetchCalls.some((call) => call.url.includes("primary.example")));
    assert.ok(fetchCalls.some((call) => call.url.includes("backup.example")));
    assert.ok(events.some((entry) => entry.event === "swap.provider.failover"));
  } finally {
    await service.close();
  }
});

test("healthy primary that omits an asset does not fall through to backup", async () => {
  const { service, fetchCalls } = await createService({
    hostBehavior: {
      "primary.example": {
        mode: "ok",
        // Primary is up but only lists SOL — no USDT_TRON mapping.
        ccies: [
          { code: "SOL", coin: "SOL", network: "SOL", recv: true, send: true },
          { code: "BTCLN", coin: "BTC", network: "LIGHTNING", recv: false, send: true },
        ],
      },
      "backup.example": { mode: "ok" },
    },
  });
  try {
    const options = await service.listSwapOptions({ amountMsats: 20_000_000 });
    const usdt = options.options.find((option) => option.payInAsset === "USDT_TRON");
    assert.equal(usdt?.available, false);
    assert.equal(usdt?.provider, "");
    assert.equal(
      fetchCalls.some((call) => call.url.includes("backup.example")),
      false,
      "backup must stay idle when primary answered",
    );
  } finally {
    await service.close();
  }
});
