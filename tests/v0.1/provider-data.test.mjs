import assert from "node:assert/strict";
import test from "node:test";
import {
  getAsset,
  getCountry,
  getProvider,
  getProviderRegistryMetadata,
  listAssets,
  listCountries,
  listCryptoRouteProviders,
  listCryptoRoutes,
  listDisqualifiedProviders,
  listFiatProviders,
  listFiatRailCountries,
  listFiatRails,
  listProviders,
  providerRegistry
} from "@openreceive/provider-data";

test("provider-data exposes canonical registry metadata and counts", () => {
  assert.deepEqual(getProviderRegistryMetadata(), {
    schema_version: "2.0.0",
    generated: "2026-06-18",
    description: providerRegistry.description,
    filter: providerRegistry.filter
  });

  assert.equal(listAssets().length, 18);
  assert.equal(listProviders().length, 36);
  assert.equal(listCryptoRoutes().length, 15);
  assert.equal(listCountries().length, 39);
  assert.equal(listDisqualifiedProviders().length, 7);
});

test("provider-data resolves crypto route providers without changing route order", () => {
  const btcLightning = listCryptoRouteProviders("btc-lightning");

  assert.equal(btcLightning[0].provider.id, "rizful");
  assert.equal(btcLightning[0].flagship, true);
  assert.deepEqual(
    btcLightning.slice(0, 4).map((entry) => entry.provider.id),
    ["rizful", "phoenix", "zeus", "walletofsatoshi"]
  );
  assert.equal(getAsset("btc")?.route, "btc-lightning");
});

test("provider-data resolves ranked fiat rail providers for a country", () => {
  const usBank = listFiatProviders({ rail: "bank", country: "US" });
  const rails = listFiatRails();

  assert.deepEqual(rails.map((rail) => rail.id), ["bank", "card"]);
  assert.equal(getCountry("US")?.currency, "USD");
  assert.equal(listFiatRailCountries("bank")[0].code, "US");
  assert.deepEqual(
    usBank.map((entry) => [entry.provider.id, entry.rank]),
    [
      ["strike", 1],
      ["river", 2],
      ["cashapp", 3],
      ["kraken", 4],
      ["coinbase", 5]
    ]
  );
});

test("provider-data filters providers and countries conservatively", () => {
  assert.equal(getProvider("strike")?.us, true);
  assert.equal(getProvider("sideshift")?.us, false);
  assert.equal(listProviders({ us: true }).every((provider) => provider.us === true), true);
  assert.equal(
    listProviders({ mechanism: "withdraw_to_invoice" }).every((provider) => provider.mechanism === "withdraw_to_invoice"),
    true
  );
  assert.equal(listCountries({ currency: "USD" }).every((country) => country.currency === "USD"), true);
});

test("provider-data exports immutable registry objects", () => {
  assert.equal(Object.isFrozen(providerRegistry), true);
  assert.equal(Object.isFrozen(providerRegistry.providers.strike), true);
  assert.throws(() => {
    providerRegistry.providers.strike.us = false;
  }, TypeError);
});
