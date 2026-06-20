import assert from "node:assert/strict";
import test from "node:test";
import {
  CoinGeckoSimplePriceProvider,
  OPENRECEIVE_MEGALITHIC_RATE_MIRROR_URL,
  OPENRECEIVE_RATE_MIRROR_URL,
  StaticPriceProvider,
  createCoinGeckoDirectPriceProvider,
  createCoinGeckoSimplePriceUrl,
  createDefaultLivePriceProviders,
  createDefaultPriceProviders,
  createMegalithicMirrorPriceProvider,
  createOpenReceiveMirrorPriceProvider,
  getBtcFiatRatesWithFallback,
  parseCoinGeckoSimplePriceResponse,
  quoteFiatToMsatsWithPrice,
  quoteFiatToMsatsWithProvider
} from "@openreceive/core";

test("parses CoinGecko-compatible BTC fiat rates as decimal strings", () => {
  const rates = parseCoinGeckoSimplePriceResponse(
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

test("builds CoinGecko direct URL with normalized fiat currencies", () => {
  assert.equal(
    createCoinGeckoSimplePriceUrl(["USD", "EUR"]),
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd%2Ceur"
  );
});

test("CoinGecko provider fetches compatible endpoint and selects requested currencies", async () => {
  const requested = [];
  const provider = new CoinGeckoSimplePriceProvider({
    url: "https://example.com/exchange_rates",
    source: "openreceive_mirror",
    fetch: async (url, init) => {
      requested.push({ url, accept: init?.headers?.accept });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          bitcoin: {
            usd: 50000,
            eur: "45000.50"
          }
        })
      };
    }
  });

  assert.deepEqual(await provider.getBtcFiatRates(["USD"]), {
    bitcoin: {
      usd: "50000"
    }
  });
  assert.deepEqual(requested, [
    {
      url: "https://example.com/exchange_rates",
      accept: "application/json"
    }
  ]);
});

test("quotes fiat to msats with a live source id using decimal math", () => {
  const quote = quoteFiatToMsatsWithPrice({
    fiat: {
      currency: "USD",
      value: "0.10"
    },
    btc_fiat_price: "50000.00",
    source: "coingecko_direct",
    as_of: 1781740800,
    ttl_seconds: 30
  });

  assert.equal(quote.amount_sats, 200);
  assert.equal(quote.amount_msats, 200000);
  assert.equal(quote.source, "coingecko_direct");
  assert.equal(quote.expires_at, 1781740830);
});

test("creates CoinGecko direct provider from currencies", () => {
  const provider = createCoinGeckoDirectPriceProvider({
    currencies: ["USD", "GBP"],
    fetch: async () => ({
      ok: true,
      status: 200,
      text: async () => "{\"bitcoin\":{\"usd\":1,\"gbp\":1}}"
    })
  });

  assert.equal(provider.source, "coingecko_direct");
  assert.equal(
    provider.url,
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd%2Cgbp"
  );
});

test("creates canonical mirror providers from source registry URLs", () => {
  const openreceive = createOpenReceiveMirrorPriceProvider();
  const megalithic = createMegalithicMirrorPriceProvider();

  assert.equal(openreceive.source, "openreceive_mirror");
  assert.equal(openreceive.url, OPENRECEIVE_RATE_MIRROR_URL);
  assert.equal(megalithic.source, "megalithic_mirror");
  assert.equal(megalithic.url, OPENRECEIVE_MEGALITHIC_RATE_MIRROR_URL);
});

test("default price providers follow static, mirror, fallback, direct order", () => {
  const providers = createDefaultPriceProviders({
    currencies: ["USD"]
  });

  assert.deepEqual(
    providers.map((provider) => provider.source),
    [
      "static_mock",
      "openreceive_mirror",
      "megalithic_mirror",
      "coingecko_direct"
    ]
  );

  assert.deepEqual(
    createDefaultLivePriceProviders({ currencies: ["USD"] }).map((provider) => provider.source),
    ["openreceive_mirror", "megalithic_mirror", "coingecko_direct"]
  );
});

test("fallback price lookup returns first successful source", async () => {
  const calls = [];
  const providers = [
    {
      source: "openreceive_mirror",
      async getBtcFiatRates() {
        calls.push("openreceive_mirror");
        throw new Error("mirror unavailable");
      }
    },
    {
      source: "megalithic_mirror",
      async getBtcFiatRates(currencies) {
        calls.push(`megalithic_mirror:${currencies.join(",")}`);
        return {
          bitcoin: {
            usd: "50001"
          }
        };
      }
    },
    {
      source: "coingecko_direct",
      async getBtcFiatRates() {
        calls.push("coingecko_direct");
        return {
          bitcoin: {
            usd: "50002"
          }
        };
      }
    }
  ];

  assert.deepEqual(
    await getBtcFiatRatesWithFallback({
      currencies: ["USD"],
      providers
    }),
    {
      source: "megalithic_mirror",
      rates: {
        bitcoin: {
          usd: "50001"
        }
      }
    }
  );
  assert.deepEqual(calls, [
    "openreceive_mirror",
    "megalithic_mirror:USD"
  ]);
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
