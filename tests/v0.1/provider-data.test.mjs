import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
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
  openReceiveProviderIconUrls,
  providerIconUrl,
  providerRegistry,
  validateRegistry
} from "@openreceive/provider-data";

function readVector(name) {
  return JSON.parse(
    readFileSync(path.join(process.cwd(), "spec/test-vectors", name), "utf8")
  );
}

test("provider-data exposes canonical registry metadata", () => {
  assert.deepEqual(getProviderRegistryMetadata(), {
    schema_version: "4.0.0",
    generated: "2026-06-20",
    description: providerRegistry.description,
    filter: providerRegistry.filter
  });
});

test("provider-data exposes master-plan getter aliases", () => {
  assert.equal(getAssets(), listAssets());
  assert.deepEqual(getProviders(), listProviders());
  assert.equal(getCryptoRoutes(), listCryptoRoutes());
  assert.deepEqual(getFiatRails(), listFiatRails());
  assert.deepEqual(getCountries(), listCountries());
  assert.equal(getDisqualifiedProviders(), listDisqualifiedProviders());
});

test("provider-data v4 keeps wizard copy and icons local", () => {
  assert.equal("summary" in providerRegistry.crypto_routes[0], false);
  assert.equal("pays_arbitrary_invoice" in providerRegistry.providers.strike, false);
  assert.equal("blurb" in providerRegistry.providers.strike, false);
  assert.equal("caveat" in providerRegistry.providers.strike, false);
  assert.equal(
    providerRegistry.crypto_routes.some((route) =>
      route.providers.some((provider) => "blurb_override" in provider)
    ),
    false
  );
  assert.equal(providerRegistry.providers.strike.icon_path, "assets/provider-icons/strike.png");
});

test("provider-data resolves bundled provider icon URLs", () => {
  const strike = providerRegistry.providers.strike;

  assert.equal(openReceiveProviderIconUrls[strike.icon_path], providerIconUrl(strike));
  assert.equal(providerIconUrl(strike).endsWith("/assets/provider-icons/strike.png"), true);
});

test("provider-data resolves crypto route providers without changing route order", () => {
  const btcLightning = listCryptoRouteProviders("btc-lightning");

  assert.equal(btcLightning.length, listProviders().length);
  assert.equal(btcLightning[0].provider.id, "rizful");
  assert.equal(btcLightning[0].flagship, true);
  assert.deepEqual(
    btcLightning.filter((entry) => entry.flagship).map((entry) => entry.provider.id),
    ["rizful", "getalby"]
  );
  assert.deepEqual(
    btcLightning.slice(0, 4).map((entry) => entry.provider.id),
    ["rizful", "getalby", "zeus", "phoenix"]
  );
  assert.deepEqual(
    btcLightning.slice(4, 13).map((entry) => [entry.provider.id, entry.rank]),
    [
      ["strike", 5],
      ["cashapp", 6],
      ["coinbase", 7],
      ["binance", 8],
      ["kraken", 9],
      ["walletofsatoshi", 10],
      ["okx", 11],
      ["bitfinex", 12],
      ["kucoin", 13]
    ]
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
      ["coinbase", 4],
      ["kraken", 5]
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
  assert.deepEqual(
    cryptoRoutes[0].providers.filter((entry) => entry.flagship).map((entry) => entry.provider.id),
    ["rizful", "getalby"]
  );

  assert.equal(fiatRoutes.length, 1);
  assert.equal(fiatRoutes[0].kind, "fiat");
  assert.equal(fiatRoutes[0].rail.id, "bank");
  assert.equal(fiatRoutes[0].country.code, "US");
  assert.equal(fiatRoutes[0].providers[0].provider.id, "strike");
});

test("provider-data satisfies canonical provider-route vectors", () => {
  const cryptoVector = readVector("provider-route.crypto-usdt.json");
  const cryptoRoutes = getPaymentWizardRoutes(cryptoVector.request);
  assert.equal(cryptoRoutes.length, cryptoVector.expected.length);
  assert.equal(cryptoRoutes[0].kind, cryptoVector.expected.kind);
  assert.equal(cryptoRoutes[0].asset.symbol, cryptoVector.expected.asset_symbol);
  assert.equal(cryptoRoutes[0].route.id, cryptoVector.expected.route_id);
  assert.deepEqual(
    cryptoRoutes[0].providers.map((entry) => entry.provider.id),
    cryptoVector.expected.provider_ids
  );
  assert.deepEqual(
    cryptoRoutes[0].providers
      .filter((entry) => entry.flagship)
      .map((entry) => entry.provider.id),
    cryptoVector.expected.flagship_provider_ids
  );

  const fiatVector = readVector("provider-route.fiat-us-card.json");
  const fiatRoutes = getPaymentWizardRoutes(fiatVector.request);
  assert.equal(fiatRoutes.length, fiatVector.expected.length);
  assert.equal(fiatRoutes[0].kind, fiatVector.expected.kind);
  assert.equal(fiatRoutes[0].rail.id, fiatVector.expected.rail_id);
  assert.equal(fiatRoutes[0].country.code, fiatVector.expected.country_code);
  assert.deepEqual(
    fiatRoutes[0].providers.map((entry) => [entry.provider.id, entry.rank]),
    fiatVector.expected.provider_ranks
  );
});

test("provider-data filters providers and countries conservatively", () => {
  assert.equal(getProvider("strike")?.us, true);
  assert.equal(getProvider("sideshift")?.us, false);
  assert.equal(getProvider("rizful")?.kind, "browser wallet");
  assert.equal(getProvider("kraken")?.kind, "exchange");
  assert.equal(getProvider("zeus")?.kind, "mobile wallet");
  assert.equal(Object.values(providerRegistry.providers).every((provider) => typeof provider.kind === "string" && provider.kind.length > 0), true);
  assert.equal(listProviders({ us: true }).every((provider) => provider.us === true), true);
  assert.equal(
    Object.values(providerRegistry.providers).every((provider) => !("mechanism" in provider)),
    true
  );
  assert.equal(listCountries({ currency: "USD" }).every((country) => country.currency === "USD"), true);
  assert.equal(providerRegistry.providers.coinbase.tutorials.length, 2);
  assert.deepEqual(
    providerRegistry.providers.boltz.tutorials.map((tutorial) => tutorial.caption),
    [
      "Select the currency you want to start with, and select Receive LN (Bitcoin Lightning)",
      "Paste Lightning invoice and click Create Swap"
    ]
  );
  assert.deepEqual(
    providerRegistry.providers.fixedfloat.tutorials.map((tutorial) => tutorial.caption),
    [
      "Choose USDT to send, then BTC Lightning to receive",
      "Paste the Lightning invoice, then tap Exchange now"
    ]
  );
  assert.equal(providerRegistry.providers.kraken.tutorials.length, 4);
  assert.deepEqual(
    providerRegistry.providers.kraken.tutorials.map((tutorial) => tutorial.caption),
    [
      "Tap Bitcoin",
      "Tap Withdraw",
      "Choose Lightning",
      "Paste or scan the invoice"
    ]
  );
  assert.equal(providerRegistry.providers.strike.tutorials.length, 4);
  assert.deepEqual(
    providerRegistry.providers.cashapp.tutorials.map((tutorial) => tutorial.path),
    [
      "assets/pay_tutorials/cashapp-1.webp",
      "assets/pay_tutorials/cashapp-2.webp",
      "assets/pay_tutorials/cashapp-3.webp",
      "assets/pay_tutorials/cashapp-4.webp",
      "assets/pay_tutorials/cashapp-5.webp",
      "assets/pay_tutorials/cashapp-6.webp"
    ]
  );
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
