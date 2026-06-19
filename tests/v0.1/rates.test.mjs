import assert from "node:assert/strict";
import test from "node:test";
import {
  CoinGeckoSimplePriceProvider,
  createCoinGeckoDirectPriceProvider,
  createCoinGeckoSimplePriceUrl,
  parseCoinGeckoSimplePriceResponse,
  quoteFiatToMsatsWithPrice
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
