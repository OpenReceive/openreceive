import assert from "node:assert/strict";
import test from "node:test";
import {
  CachedPriceFeed,
  HttpSimplePriceProvider,
  InMemoryInvoiceKvStore,
  OPENRECEIVE_FALLBACK_PRICE_FEED_URL,
  OPENRECEIVE_PRICE_FEED_PRIMARY_TIMEOUT_MS,
  OPENRECEIVE_PRIMARY_PRICE_FEED_URL,
  StaticPriceProvider,
  createCachedLivePriceFeed,
  createLivePriceFeedProviders,
  createSimplePriceUrl,
  getBtcFiatRatesWithFallback,
  isHealthCheckablePriceFeed,
  isResolvedPriceProvider,
  parseSimplePriceResponse,
  quoteFiatToMsatsWithPrice,
  quoteFiatToMsatsWithProvider
} from "@openreceive/core";

const PRIMARY_URL = "https://primary.test/simple/price";
const FALLBACK_URL = "https://fallback.test/simple/price";

function okResponse(body) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body)
  };
}

function httpErrorResponse(status) {
  return {
    ok: false,
    status,
    text: async () => ""
  };
}

// Records every fetch and dispatches a per-URL handler so tests can stage
// success, HTTP errors, or a hang (for the timeout path).
function stageFetch(handlers) {
  const calls = [];
  const fetch = (url, init) => {
    calls.push({ url, accept: init?.headers?.accept, hasSignal: init?.signal !== undefined });
    const handler = handlers[url];
    if (handler === undefined) throw new Error(`unexpected fetch URL: ${url}`);
    return handler();
  };
  return { fetch, calls };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not met");
}

test("parses Simple Price BTC fiat rates as decimal strings", () => {
  const rates = parseSimplePriceResponse(
    {
      bitcoin: {
        usd: 62599,
        eur: "54792.12"
      }
    },
    ["USD", "EUR"]
  );

  assert.deepEqual(rates, {
    bitcoin: {
      usd: "62599",
      eur: "54792.12"
    }
  });
});

test("builds a Simple Price URL with normalized fiat currencies", () => {
  assert.equal(
    createSimplePriceUrl(["USD", "EUR"]),
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd%2Ceur"
  );
});

test("HTTP provider fetches the endpoint and selects requested currencies", async () => {
  const { fetch, calls } = stageFetch({
    [PRIMARY_URL]: () => okResponse({ bitcoin: { usd: 50000, eur: "45000.50" } })
  });
  const provider = new HttpSimplePriceProvider({
    url: PRIMARY_URL,
    source: "primary",
    fetch
  });

  assert.deepEqual(await provider.getBtcFiatRates(["USD"]), {
    bitcoin: { usd: "50000" }
  });
  assert.deepEqual(calls, [
    { url: PRIMARY_URL, accept: "application/json", hasSignal: false }
  ]);
});

test("HTTP provider aborts and rejects when the endpoint exceeds its timeout", async () => {
  const { fetch, calls } = stageFetch({
    [PRIMARY_URL]: () => new Promise(() => {})
  });
  const provider = new HttpSimplePriceProvider({
    url: PRIMARY_URL,
    source: "primary",
    fetch,
    timeoutMs: 20
  });

  await assert.rejects(
    () => provider.getBtcFiatRates(["USD"]),
    /price source primary did not respond within 20ms/
  );
  assert.equal(calls[0].hasSignal, true);
});

test("live feed providers pin the hard-coded URLs and 5s primary timeout", () => {
  const { primary, fallback } = createLivePriceFeedProviders();

  assert.equal(primary.source, "primary");
  assert.equal(primary.url, OPENRECEIVE_PRIMARY_PRICE_FEED_URL);
  assert.equal(primary.timeoutMs, OPENRECEIVE_PRICE_FEED_PRIMARY_TIMEOUT_MS);
  assert.equal(fallback.source, "fallback");
  assert.equal(fallback.url, OPENRECEIVE_FALLBACK_PRICE_FEED_URL);
  assert.equal(fallback.timeoutMs, undefined);

  const overridden = createLivePriceFeedProviders({
    primaryUrl: PRIMARY_URL,
    fallbackUrl: FALLBACK_URL
  });
  assert.equal(overridden.primary.url, PRIMARY_URL);
  assert.equal(overridden.fallback.url, FALLBACK_URL);
});

test("cached feed serves from the database within the cache window", async () => {
  let now = 1000;
  const store = new InMemoryInvoiceKvStore();
  const { fetch, calls } = stageFetch({
    [PRIMARY_URL]: () => okResponse({ bitcoin: { usd: 70000, eur: 64000 } })
  });
  const feed = createCachedLivePriceFeed({
    store,
    currencies: ["USD", "EUR"],
    fetch,
    clock: () => now,
    primaryUrl: PRIMARY_URL,
    fallbackUrl: FALLBACK_URL
  });

  const first = await feed.getBtcFiatRatesWithSource(["USD"]);
  assert.equal(first.source, "primary");
  assert.deepEqual(first.rates, { bitcoin: { usd: "70000" } });
  assert.equal(calls.length, 1);

  // A different currency within the window is served from the cached blob,
  // with no extra network call.
  now = 1059;
  const second = await feed.getBtcFiatRatesWithSource(["EUR"]);
  assert.deepEqual(second.rates, { bitcoin: { eur: "64000" } });
  assert.equal(calls.length, 1);

  // The cached JSON blob and its fetch time are durable in the meta store.
  const cached = JSON.parse((await store.getMeta("price_feed:bitcoin")).value);
  assert.equal(cached.source, "primary");
  assert.equal(cached.fetched_at, 1000);
  assert.deepEqual(cached.rates, { bitcoin: { usd: "70000", eur: "64000" } });
});

test("cached feed refreshes once the cache is older than 60 seconds", async () => {
  let now = 1000;
  const store = new InMemoryInvoiceKvStore();
  let usd = 70000;
  const { fetch, calls } = stageFetch({
    [PRIMARY_URL]: () => okResponse({ bitcoin: { usd } })
  });
  const feed = createCachedLivePriceFeed({
    store,
    currencies: ["USD"],
    fetch,
    clock: () => now,
    primaryUrl: PRIMARY_URL,
    fallbackUrl: FALLBACK_URL
  });

  await feed.getBtcFiatRatesWithSource(["USD"]);
  assert.equal(calls.length, 1);

  now = 1060;
  usd = 71000;
  const refreshed = await feed.getBtcFiatRatesWithSource(["USD"]);
  assert.deepEqual(refreshed.rates, { bitcoin: { usd: "71000" } });
  assert.equal(calls.length, 2);
});

test("cached feed serves stale DB rates during a claimed refresh", async () => {
  let now = 1000;
  let primaryHandler = () => okResponse({ bitcoin: { usd: 70000 } });
  const store = new InMemoryInvoiceKvStore();
  const { fetch, calls } = stageFetch({
    [PRIMARY_URL]: () => primaryHandler()
  });
  const feed = createCachedLivePriceFeed({
    store,
    currencies: ["USD"],
    fetch,
    clock: () => now,
    primaryUrl: PRIMARY_URL,
    fallbackUrl: FALLBACK_URL
  });

  await feed.getBtcFiatRatesWithSource(["USD"]);
  assert.equal(calls.length, 1);

  now = 1060;
  const refresh = deferred();
  primaryHandler = () => refresh.promise;
  const refreshing = feed.getBtcFiatRatesWithSource(["USD"]);
  await waitFor(() => calls.length === 2);

  const concurrent = await feed.getBtcFiatRatesWithSource(["USD"]);
  assert.deepEqual(concurrent.rates, { bitcoin: { usd: "70000" } });
  assert.equal(calls.length, 2);

  refresh.resolve(okResponse({ bitcoin: { usd: 71000 } }));
  const refreshed = await refreshing;
  assert.deepEqual(refreshed.rates, { bitcoin: { usd: "71000" } });
  assert.equal(calls.length, 2);

  const cached = JSON.parse((await store.getMeta("price_feed:bitcoin")).value);
  assert.equal(cached.fetched_at, 1060);
  assert.equal(cached.refresh_started_at, undefined);
});

test("cached feed throttles failed refresh attempts through the database", async () => {
  let now = 1000;
  const store = new InMemoryInvoiceKvStore();
  const { fetch, calls } = stageFetch({
    [PRIMARY_URL]: () => httpErrorResponse(500),
    [FALLBACK_URL]: () => httpErrorResponse(503)
  });
  const feed = createCachedLivePriceFeed({
    store,
    currencies: ["USD"],
    fetch,
    clock: () => now,
    primaryUrl: PRIMARY_URL,
    fallbackUrl: FALLBACK_URL
  });

  await assert.rejects(
    () => feed.getBtcFiatRatesWithSource(["USD"]),
    /all price feeds failed: primary: .*HTTP 500.*fallback: .*HTTP 503/
  );
  assert.deepEqual(calls.map((call) => call.url), [PRIMARY_URL, FALLBACK_URL]);

  const failed = JSON.parse((await store.getMeta("price_feed:bitcoin")).value);
  assert.equal(failed.refresh_failed_at, 1000);
  assert.match(failed.refresh_error, /all price feeds failed/);

  await assert.rejects(
    () => feed.getBtcFiatRatesWithSource(["USD"]),
    /price feed refresh already failed within 60s/
  );
  assert.equal(calls.length, 2);

  now = 1060;
  await assert.rejects(
    () => feed.getBtcFiatRatesWithSource(["USD"]),
    /all price feeds failed/
  );
  assert.equal(calls.length, 4);
});

test("cached feed falls back to the second URL when the primary times out", async () => {
  const now = 1000;
  const store = new InMemoryInvoiceKvStore();
  const { fetch, calls } = stageFetch({
    [PRIMARY_URL]: () => new Promise(() => {}),
    [FALLBACK_URL]: () => okResponse({ bitcoin: { usd: 68000 } })
  });
  const feed = createCachedLivePriceFeed({
    store,
    currencies: ["USD"],
    fetch,
    clock: () => now,
    primaryUrl: PRIMARY_URL,
    fallbackUrl: FALLBACK_URL,
    primaryTimeoutMs: 20
  });

  const result = await feed.getBtcFiatRatesWithSource(["USD"]);
  assert.equal(result.source, "fallback");
  assert.deepEqual(result.rates, { bitcoin: { usd: "68000" } });
  assert.deepEqual(calls.map((call) => call.url), [PRIMARY_URL, FALLBACK_URL]);

  const cached = JSON.parse((await store.getMeta("price_feed:bitcoin")).value);
  assert.equal(cached.source, "fallback");
});

test("cached feed tolerates an upstream dropping one configured currency", async () => {
  const store = new InMemoryInvoiceKvStore();
  // Configured for USD + EUR, but the feed only returns USD this round.
  const { fetch, calls } = stageFetch({
    [PRIMARY_URL]: () => okResponse({ bitcoin: { usd: 70000 } })
  });
  const feed = createCachedLivePriceFeed({
    store,
    currencies: ["USD", "EUR"],
    fetch,
    clock: () => 1000,
    primaryUrl: PRIMARY_URL,
    fallbackUrl: FALLBACK_URL
  });

  // The refresh succeeds and caches what was available...
  const usd = await feed.getBtcFiatRatesWithSource(["USD"]);
  assert.deepEqual(usd.rates, { bitcoin: { usd: "70000" } });
  assert.equal(calls.length, 1);

  // ...but a request for the dropped currency fails on its own, served from the
  // same fresh cache without another network call.
  await assert.rejects(() => feed.getBtcFiatRatesWithSource(["EUR"]));
  assert.equal(calls.length, 1);
});

test("cached feed throws when neither the primary nor fallback URL responds", async () => {
  const store = new InMemoryInvoiceKvStore();
  const { fetch } = stageFetch({
    [PRIMARY_URL]: () => httpErrorResponse(500),
    [FALLBACK_URL]: () => httpErrorResponse(503)
  });
  const feed = createCachedLivePriceFeed({
    store,
    currencies: ["USD"],
    fetch,
    clock: () => 1000,
    primaryUrl: PRIMARY_URL,
    fallbackUrl: FALLBACK_URL
  });

  await assert.rejects(
    () => feed.healthCheck(),
    /all price feeds failed: primary: .*HTTP 500.*fallback: .*HTTP 503/
  );
});

test("health check forces a live refresh even when the cache is fresh", async () => {
  let now = 1000;
  const store = new InMemoryInvoiceKvStore();
  const { fetch, calls } = stageFetch({
    [PRIMARY_URL]: () => okResponse({ bitcoin: { usd: 70000 } })
  });
  const feed = createCachedLivePriceFeed({
    store,
    currencies: ["USD"],
    fetch,
    clock: () => now,
    primaryUrl: PRIMARY_URL,
    fallbackUrl: FALLBACK_URL
  });

  await feed.getBtcFiatRatesWithSource(["USD"]);
  assert.equal(calls.length, 1);

  now = 1010;
  const probe = await feed.healthCheck(["USD"]);
  assert.equal(probe.source, "primary");
  assert.equal(calls.length, 2);
});

test("cached feed is recognized as resolved and health-checkable", () => {
  const feed = new CachedPriceFeed({
    store: new InMemoryInvoiceKvStore(),
    currencies: ["USD"],
    primary: new StaticPriceProvider(),
    fallback: new StaticPriceProvider()
  });
  assert.equal(isResolvedPriceProvider(feed), true);
  assert.equal(isHealthCheckablePriceFeed(feed), true);
  assert.equal(isResolvedPriceProvider(new StaticPriceProvider()), false);
  assert.equal(isHealthCheckablePriceFeed(new StaticPriceProvider()), false);
});

test("quotes fiat to msats with a live source id using decimal math", () => {
  const quote = quoteFiatToMsatsWithPrice({
    fiat: {
      currency: "USD",
      value: "0.10"
    },
    btc_fiat_price: "50000.00",
    source: "primary",
    as_of: 1781740800,
    ttl_seconds: 30
  });

  assert.equal(quote.amount_sats, 200);
  assert.equal(quote.amount_msats, 200000);
  assert.equal(quote.source, "primary");
  assert.equal(quote.expires_at, 1781740830);
});

test("fallback price lookup reports the resolved source from a cached feed", async () => {
  const store = new InMemoryInvoiceKvStore();
  const { fetch } = stageFetch({
    [PRIMARY_URL]: () => okResponse({ bitcoin: { usd: 50001 } })
  });
  const feed = createCachedLivePriceFeed({
    store,
    currencies: ["USD"],
    fetch,
    clock: () => 1000,
    primaryUrl: PRIMARY_URL,
    fallbackUrl: FALLBACK_URL
  });

  assert.deepEqual(
    await getBtcFiatRatesWithFallback({ currencies: ["USD"], providers: [feed] }),
    {
      source: "primary",
      rates: { bitcoin: { usd: "50001" } }
    }
  );
});

test("static provider and provider-backed quote expose source ids", async () => {
  const staticProvider = new StaticPriceProvider();
  const rates = await staticProvider.getBtcFiatRates(["USD"]);
  assert.deepEqual(rates, {
    bitcoin: {
      usd: "50000.00"
    }
  });

  const quote = await quoteFiatToMsatsWithProvider({
    fiat: {
      currency: "USD",
      value: "0.10"
    },
    provider: staticProvider,
    as_of: 1781740800
  });

  assert.equal(quote.source, "static_mock");
  assert.equal(quote.amount_msats, 200000);
});
