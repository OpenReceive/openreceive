import assert from "node:assert/strict";
import test from "node:test";
import {
  CachedPriceFeed,
  OPENRECEIVE_INVOICE_QUOTE_TTL_SECONDS,
  OPENRECEIVE_PRICE_FEED_FALLBACK_TIMEOUT_MS,
  OPENRECEIVE_PRICE_FEED_PRIMARY_TIMEOUT_MS,
  StaticPriceProvider,
  createCachedLivePriceFeed,
} from "../packages/js/core/src/index.ts";
import { createOpenReceive } from "../packages/js/node/src/index.ts";
import { createTestkitReceiveClient } from "../packages/js/testkit/src/index.ts";

function fakePriceFetch(rates = { bitcoin: { usd: "68000.00" } }) {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify(rates);
      },
    };
  };
  return { calls, fetcher };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });
  return { promise, resolve, reject };
}

function settleMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("fiat pricing defaults to the live feed, never the static mock", async () => {
  const { calls, fetcher } = fakePriceFetch();
  const service = await createOpenReceive({
    client: createTestkitReceiveClient({ now: () => 1000 }),
    clock: () => 1000,
    priceFetch: fetcher,
  });
  const prepared = await service.prepareCheckout({
    amount: { currency: "USD", value: "100" },
  });
  assert.ok(calls.length >= 1, "the live feed must be consulted");
  assert.equal(prepared.fiatQuote.source, "primary");
  assert.notEqual(prepared.fiatQuote.source, "static_mock");
});

test("fiat checkout REFUSES with a retryable 503 when rates are unavailable", async () => {
  const service = await createOpenReceive({
    client: createTestkitReceiveClient({ now: () => 1000 }),
    clock: () => 1000,
    priceFetch: async () => {
      throw new Error("feed down");
    },
  });
  await assert.rejects(
    service.createCheckout({ orderId: "order-rates", amount: { currency: "USD", value: "100" } }),
    (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.body.retryable, true);
      assert.match(error.body.message, /Exchange rates are temporarily unavailable/);
      return true;
    },
  );
});

test("a provider currency gap maps to the same retryable 503, not a payer 400", async () => {
  const service = await createOpenReceive({
    client: createTestkitReceiveClient({ now: () => 1000 }),
    clock: () => 1000,
    priceCurrencies: ["USD", "EUR"],
    // The feed answers, but without EUR.
    priceFetch: fakePriceFetch({ bitcoin: { usd: "68000.00" } }).fetcher,
  });
  await assert.rejects(
    service.createCheckout({ orderId: "order-gap", amount: { currency: "EUR", value: "50" } }),
    (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.body.retryable, true);
      return true;
    },
  );
});

test("explicit StaticPriceProvider opt-in still works for tests and offline dev", async () => {
  const service = await createOpenReceive({
    client: createTestkitReceiveClient({ now: () => 1000 }),
    clock: () => 1000,
    priceProviders: [new StaticPriceProvider()],
  });
  const prepared = await service.prepareCheckout({
    amount: { currency: "USD", value: "100" },
  });
  assert.equal(prepared.fiatQuote.source, "static_mock");
});

test("an entry older than the quote TTL is never served; callers await the fresh fetch", async () => {
  let now = 0;
  let pending = deferred();
  const calls = [];
  const provider = (source) => ({
    source,
    async getBtcFiatRates() {
      calls.push(source);
      return pending.promise;
    },
  });
  const feed = new CachedPriceFeed({
    currencies: ["USD"],
    primary: provider("primary"),
    fallback: provider("fallback"),
    clock: () => now,
  });

  pending.resolve({ bitcoin: { usd: "68000.00" } });
  assert.equal((await feed.getBtcFiatRatesWithSource(["USD"])).rates.bitcoin.usd, "68000.00");

  // Past the quote TTL the cached observation is unusable. Both callers must
  // end up on the SAME live refresh, never on the ancient entry.
  now = OPENRECEIVE_INVOICE_QUOTE_TTL_SECONDS + 100;
  pending = deferred();
  const first = feed.getBtcFiatRatesWithSource(["USD"]);
  await settleMicrotasks();
  const second = feed.getBtcFiatRatesWithSource(["USD"]);
  await settleMicrotasks();
  pending.resolve({ bitcoin: { usd: "71000.00" } });

  assert.equal((await first).rates.bitcoin.usd, "71000.00");
  assert.equal((await second).rates.bitcoin.usd, "71000.00");
  assert.deepEqual(calls, ["primary", "primary"], "the joined caller must not fetch again");
});

test("stale-while-revalidate still serves entries younger than the quote TTL", async () => {
  let now = 0;
  let hang = false;
  const provider = (source) => ({
    source,
    async getBtcFiatRates() {
      if (!hang) return { bitcoin: { usd: "68000.00" } };
      return new Promise(() => {});
    },
  });
  const feed = new CachedPriceFeed({
    currencies: ["USD"],
    primary: provider("primary"),
    fallback: provider("fallback"),
    clock: () => now,
  });
  await feed.getBtcFiatRatesWithSource(["USD"]);

  // Past the 60s cache but well inside the 600s quote TTL.
  now = 120;
  hang = true;
  const claimed = feed.getBtcFiatRatesWithSource(["USD"]);
  claimed.catch(() => {});
  await settleMicrotasks();
  const served = await feed.getBtcFiatRatesWithSource(["USD"]);
  assert.equal(served.rates.bitcoin.usd, "68000.00");
});

test("a cold-cache burst shares one refresh instead of refusing all but the claimer", async () => {
  const pending = deferred();
  let calls = 0;
  const provider = (source) => ({
    source,
    async getBtcFiatRates() {
      calls += 1;
      return pending.promise;
    },
  });
  const feed = new CachedPriceFeed({
    currencies: ["USD"],
    primary: provider("primary"),
    fallback: provider("fallback"),
    clock: () => 1000,
  });

  const readers = [
    feed.getBtcFiatRatesWithSource(["USD"]),
    feed.getBtcFiatRatesWithSource(["USD"]),
    feed.getBtcFiatRatesWithSource(["USD"]),
  ];
  await settleMicrotasks();
  pending.resolve({ bitcoin: { usd: "68000.00" } });

  for (const reader of await Promise.all(readers)) {
    assert.equal(reader.rates.bitcoin.usd, "68000.00");
    assert.equal(reader.source, "primary");
  }
  assert.equal(calls, 1, "one live fetch, not one per caller");
});

test("one failed refresh does not hard-down quoting while an entry is still quotable", async () => {
  let now = 0;
  let failing = false;
  const provider = (source) => ({
    source,
    async getBtcFiatRates() {
      if (failing) throw new Error(`${source} blip`);
      return { bitcoin: { usd: "68000.00" } };
    },
  });
  const feed = new CachedPriceFeed({
    currencies: ["USD"],
    primary: provider("primary"),
    fallback: provider("fallback"),
    clock: () => now,
  });
  await feed.getBtcFiatRatesWithSource(["USD"]);

  now = 120;
  failing = true;
  await assert.rejects(feed.getBtcFiatRatesWithSource(["USD"]), /all price feeds failed/);

  // Still inside the backoff window, and the preserved entry is inside the
  // quote TTL: reads keep working instead of 503-ing for the whole backoff.
  now = 125;
  const served = await feed.getBtcFiatRatesWithSource(["USD"]);
  assert.equal(served.rates.bitcoin.usd, "68000.00");
});

test("a failed refresh with nothing quotable in hand still refuses", async () => {
  let now = 0;
  const provider = (source) => ({
    source,
    async getBtcFiatRates() {
      throw new Error(`${source} down`);
    },
  });
  const feed = new CachedPriceFeed({
    currencies: ["USD"],
    primary: provider("primary"),
    fallback: provider("fallback"),
    clock: () => now,
  });

  await assert.rejects(feed.getBtcFiatRatesWithSource(["USD"]), /all price feeds failed/);
  now = 5;
  await assert.rejects(
    feed.getBtcFiatRatesWithSource(["USD"]),
    /price feed refresh already failed/,
  );
});

test("a cache window wider than the quote TTL is refused at construction", () => {
  const provider = (source) => ({
    source,
    async getBtcFiatRates() {
      return { bitcoin: { usd: "68000.00" } };
    },
  });
  const build = (cacheSeconds) =>
    new CachedPriceFeed({
      currencies: ["USD"],
      primary: provider("primary"),
      fallback: provider("fallback"),
      cacheSeconds,
    });

  assert.throws(
    () => build(OPENRECEIVE_INVOICE_QUOTE_TTL_SECONDS + 1),
    /must not exceed the 600s invoice quote TTL/,
  );
  assert.throws(() => build(0), /must be a positive integer/);
  assert.doesNotThrow(() => build(OPENRECEIVE_INVOICE_QUOTE_TTL_SECONDS));
});

test("a backwards clock step reads as stale, not as fresh forever", async () => {
  let now = 1000;
  let rate = "68000.00";
  const provider = (source) => ({
    source,
    async getBtcFiatRates() {
      return { bitcoin: { usd: rate } };
    },
  });
  const feed = new CachedPriceFeed({
    currencies: ["USD"],
    primary: provider("primary"),
    fallback: provider("fallback"),
    clock: () => now,
  });
  assert.equal((await feed.getBtcFiatRatesWithSource(["USD"])).rates.bitcoin.usd, "68000.00");

  // Small skew is tolerated: the entry stays fresh.
  now = 998;
  rate = "71000.00";
  assert.equal((await feed.getBtcFiatRatesWithSource(["USD"])).rates.bitcoin.usd, "68000.00");

  // A real backwards step must not leave the entry "fresh" until wall-clock
  // catches up — it refreshes.
  now = 900;
  assert.equal((await feed.getBtcFiatRatesWithSource(["USD"])).rates.bitcoin.usd, "71000.00");
});

test("a missing currency names the currency and the source, not a decimal-shape complaint", async () => {
  const feed = new CachedPriceFeed({
    currencies: ["USD"],
    primary: {
      source: "primary",
      async getBtcFiatRates() {
        return { bitcoin: { usd: "68000.00" } };
      },
    },
    fallback: {
      source: "fallback",
      async getBtcFiatRates() {
        throw new Error("unused");
      },
    },
    clock: () => 1000,
  });

  await assert.rejects(feed.getBtcFiatRatesWithSource(["EUR"]), (error) => {
    assert.match(error.message, /rate for EUR not available from primary/);
    assert.doesNotMatch(error.message, /must be a number or decimal string/);
    return true;
  });
});

test("healthCheck forces a live refresh and reports which feed answered", async () => {
  const feed = new CachedPriceFeed({
    currencies: ["USD"],
    primary: {
      source: "primary",
      async getBtcFiatRates() {
        throw new Error("primary down");
      },
    },
    fallback: {
      source: "fallback",
      async getBtcFiatRates() {
        return { bitcoin: { usd: "68000.00" } };
      },
    },
    clock: () => 1000,
  });

  const probe = await feed.healthCheck(["USD"]);
  assert.equal(probe.source, "fallback");
  assert.equal(probe.rates.bitcoin.usd, "68000.00");
});

test("both live feeds are time-bounded, so a black-holed fallback cannot stall quoting", async () => {
  assert.ok(OPENRECEIVE_PRICE_FEED_FALLBACK_TIMEOUT_MS > 0);
  assert.ok(
    OPENRECEIVE_PRICE_FEED_FALLBACK_TIMEOUT_MS >= OPENRECEIVE_PRICE_FEED_PRIMARY_TIMEOUT_MS,
  );

  const feed = createCachedLivePriceFeed({
    currencies: ["USD"],
    clock: () => 1000,
    primaryTimeoutMs: 5,
    fallbackTimeoutMs: 5,
    fetch: () => new Promise(() => {}),
  });

  await assert.rejects(feed.getBtcFiatRatesWithSource(["USD"]), (error) => {
    assert.match(error.message, /primary did not respond within 5ms/);
    assert.match(error.message, /fallback did not respond within 5ms/);
    return true;
  });
});

test("core rate constants match spec/data/rates/price-sources.json", async () => {
  const { readFileSync } = await import("node:fs");
  const core = await import("../packages/js/core/src/index.ts");
  const spec = JSON.parse(readFileSync("spec/data/rates/price-sources.json", "utf8"));
  assert.equal(core.OPENRECEIVE_PRICE_FEED_CACHE_SECONDS, spec.cache_seconds);
  assert.equal(core.OPENRECEIVE_INVOICE_QUOTE_TTL_SECONDS, spec.invoice_quote_ttl_seconds);
  assert.equal(core.OPENRECEIVE_PRICE_FEED_PRIMARY_TIMEOUT_MS, spec.primary_timeout_ms);
  const byId = Object.fromEntries(spec.sources.map((source) => [source.id, source]));
  assert.equal(core.OPENRECEIVE_PRIMARY_PRICE_FEED_URL, byId.primary.url);
  assert.equal(core.OPENRECEIVE_FALLBACK_PRICE_FEED_URL, byId.fallback.url);
  assert.deepEqual(core.OPENRECEIVE_STATIC_BTC_FIAT_RATES, byId.static_mock.rates);
  assert.equal(byId.primary.env_override, core.OPENRECEIVE_PRICE_FEED_PRIMARY_URL_ENV);
  assert.equal(byId.fallback.env_override, core.OPENRECEIVE_PRICE_FEED_FALLBACK_URL_ENV);
});
