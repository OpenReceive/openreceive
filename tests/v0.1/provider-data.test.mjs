import assert from "node:assert/strict";
import test from "node:test";
import {
  getAsset,
  getAssets,
  getCountry,
  getCountries,
  getCountryRoutes,
  getCryptoRoutes,
  getDisqualifiedProviders,
  getFiatRails,
  getPaymentWizardRoutes,
  getProvider,
  getProviders,
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
  providerRegistry,
  validateRegistry
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

test("provider-data exposes master-plan getter aliases", () => {
  assert.equal(getAssets(), listAssets());
  assert.deepEqual(getProviders(), listProviders());
  assert.equal(getCryptoRoutes(), listCryptoRoutes());
  assert.deepEqual(getFiatRails(), listFiatRails());
  assert.deepEqual(getCountries(), listCountries());
  assert.equal(getDisqualifiedProviders(), listDisqualifiedProviders());
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

test("provider-data resolves country routes for payment wizard selection", () => {
  const usRoutes = getCountryRoutes("us");

  assert.deepEqual(
    usRoutes.map((route) => route.rail.id),
    ["bank", "card"]
  );
  assert.equal(usRoutes[0].country.code, "US");
  assert.equal(usRoutes[0].providers[0].provider.id, "strike");
  assert.equal(usRoutes[0].providers[0].rank, 1);
});

test("provider-data resolves payment wizard routes from asset and fiat inputs", () => {
  const cryptoRoutes = getPaymentWizardRoutes({ asset: "BTC" });
  const fiatRoutes = getPaymentWizardRoutes({ rail: "bank", country: "us" });

  assert.equal(cryptoRoutes.length, 1);
  assert.equal(cryptoRoutes[0].kind, "crypto");
  assert.equal(cryptoRoutes[0].route.id, "btc-lightning");
  assert.equal(cryptoRoutes[0].asset.symbol, "btc");
  assert.equal(cryptoRoutes[0].providers[0].provider.id, "rizful");
  assert.equal(cryptoRoutes[0].providers[0].flagship, true);

  assert.equal(fiatRoutes.length, 1);
  assert.equal(fiatRoutes[0].kind, "fiat");
  assert.equal(fiatRoutes[0].rail.id, "bank");
  assert.equal(fiatRoutes[0].country.code, "US");
  assert.equal(fiatRoutes[0].providers[0].provider.id, "strike");
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

test("provider-data validates registry references without exiting", () => {
  assert.deepEqual(validateRegistry(), { valid: true, errors: [] });

  const brokenRegistry = {
    ...providerRegistry,
    crypto_routes: [
      {
        ...providerRegistry.crypto_routes[0],
        providers: [{ provider: "missing-provider" }]
      },
      ...providerRegistry.crypto_routes.slice(1)
    ]
  };
  const result = validateRegistry(brokenRegistry);

  assert.equal(result.valid, false);
  assert.equal(result.errors.some((error) => error.includes("references missing provider missing-provider")), true);
});

test("provider-data validation rejects duplicate route and provider entries", () => {
  const firstCryptoRoute = providerRegistry.crypto_routes[0];
  const firstCountry = providerRegistry.countries[0];
  const firstDisqualifiedProvider = providerRegistry.disqualified_providers[0];
  const firstBankProvider = providerRegistry.fiat_rails.bank.countries.US[0];

  const brokenRegistry = {
    ...providerRegistry,
    crypto_routes: [
      {
        ...firstCryptoRoute,
        providers: [
          firstCryptoRoute.providers[0],
          firstCryptoRoute.providers[0],
          ...firstCryptoRoute.providers.slice(1)
        ]
      },
      firstCryptoRoute,
      ...providerRegistry.crypto_routes.slice(1)
    ],
    countries: [
      firstCountry,
      ...providerRegistry.countries
    ],
    fiat_rails: {
      ...providerRegistry.fiat_rails,
      bank: {
        ...providerRegistry.fiat_rails.bank,
        countries: {
          ...providerRegistry.fiat_rails.bank.countries,
          US: [
            firstBankProvider,
            firstBankProvider,
            ...providerRegistry.fiat_rails.bank.countries.US.slice(1)
          ]
        }
      }
    },
    disqualified_providers: [
      firstDisqualifiedProvider,
      ...providerRegistry.disqualified_providers
    ]
  };

  const result = validateRegistry(brokenRegistry);

  assert.equal(result.valid, false);
  assert.equal(result.errors.includes("crypto route id btc-lightning is duplicated"), true);
  assert.equal(result.errors.includes("country code US is duplicated"), true);
  assert.equal(result.errors.includes("disqualified provider relai is duplicated"), true);
  assert.equal(
    result.errors.includes("crypto route btc-lightning references provider rizful more than once"),
    true
  );
  assert.equal(
    result.errors.includes("fiat rail bank/US references provider strike more than once"),
    true
  );
});
