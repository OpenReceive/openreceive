import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  getAsset,
  getPaymentWizardRoutes,
  getProvider,
  getProviderRegistryMetadata,
  listCryptoRouteProviders,
  listProviders,
  loadPayTutorialImages,
  payTutorialImage,
  providerIconUrls,
  providerIconUrl,
  providerRegistry,
  validateRegistry,
} from "@openreceive/provider-data";

function readVector(name) {
  return JSON.parse(readFileSync(path.join(process.cwd(), "spec/test-vectors", name), "utf8"));
}

test("provider-data exposes well-formed registry metadata", () => {
  // Shape invariants, not a transcription of the current registry content: the
  // metadata must stay consistent with the registry without this test needing an
  // edit every time the registry is regenerated.
  const metadata = getProviderRegistryMetadata();
  assert.deepEqual(Object.keys(metadata).sort(), [
    "description",
    "filter",
    "generated",
    "schema_version",
  ]);
  assert.match(metadata.schema_version, /^4\.\d+\.\d+$/, "v4 registry major version");
  assert.match(metadata.generated, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(metadata.schema_version, providerRegistry.schema_version);
  assert.equal(metadata.generated, providerRegistry.generated);
  assert.equal(metadata.description, providerRegistry.description);
  assert.equal(metadata.filter, providerRegistry.filter);
  assert.ok(metadata.description.length > 0);
  assert.ok(metadata.filter.length > 0);
});

test("provider-data v4 keeps wizard copy and icons local", () => {
  assert.equal("summary" in providerRegistry.crypto_routes[0], false);
  assert.equal("pays_arbitrary_invoice" in providerRegistry.providers.strike, false);
  assert.equal("blurb" in providerRegistry.providers.strike, false);
  assert.equal("caveat" in providerRegistry.providers.strike, false);
  assert.equal(
    providerRegistry.crypto_routes.some((route) =>
      route.providers.some((provider) => "blurb_override" in provider),
    ),
    false,
  );
  assert.equal(providerRegistry.providers.strike.icon_path, "assets/provider-icons/strike.webp");
  // The fiat/country wing was removed: crypto routes are the only route kind.
  assert.equal("countries" in providerRegistry, false);
  assert.equal("fiat_rails" in providerRegistry, false);
});

test("provider-data ships every wallet logo inside the JavaScript", () => {
  const strike = providerRegistry.providers.strike;

  assert.equal(providerIconUrls[strike.icon_path], providerIconUrl(strike));
  assert.match(providerIconUrl(strike), /^data:image\/webp;base64,[A-Za-z0-9+/=]+$/);
  assert.equal(Object.isFrozen(providerIconUrls), true);
});

test("provider-data ships the pay tutorials behind one lazy load", async () => {
  const coinbaseTutorial = providerRegistry.providers.coinbase.tutorials[0];
  const krakenTutorial = providerRegistry.providers.kraken.tutorials[3];

  const images = await loadPayTutorialImages();
  assert.equal(Object.isFrozen(images), true);
  assert.match(
    payTutorialImage(coinbaseTutorial.path),
    /^data:image\/webp;base64,[A-Za-z0-9+/=]+$/,
  );
  assert.equal(payTutorialImage(krakenTutorial.path), images[krakenTutorial.path]);
  assert.equal(payTutorialImage("assets/pay_tutorials/missing.webp"), undefined);
});

test("provider-data resolves crypto route providers in registry rank order", () => {
  // Rank rule (invariant, not a transcription of the current ranking): every
  // route's resolved list is exactly the registry entries ordered by rank, the
  // ranks are contiguous 1..N, and every entry resolves to a real provider.
  for (const route of providerRegistry.crypto_routes) {
    const resolved = listCryptoRouteProviders(route.id);
    assert.equal(resolved.length, route.providers.length, route.id);
    const ranked = route.providers.every((entry) => typeof entry.rank === "number");
    if (ranked) {
      assert.deepEqual(
        resolved.map((entry) => entry.rank),
        resolved.map((_, index) => index + 1),
        `${route.id}: ranks must be contiguous 1..N in order`,
      );
      assert.deepEqual(
        resolved.map((entry) => entry.provider.id),
        [...route.providers].sort((a, b) => a.rank - b.rank).map((entry) => entry.provider),
        `${route.id}: resolved order must be the registry's rank order`,
      );
    } else {
      // Rankless routes keep the registry's declaration order.
      assert.deepEqual(
        resolved.map((entry) => entry.provider.id),
        route.providers.map((entry) => entry.provider),
        `${route.id}: resolved order must be the registry's declaration order`,
      );
    }
    for (const entry of resolved) {
      assert.equal(entry.provider, getProvider(entry.provider.id), entry.provider.id);
    }
  }

  // Sentinels: the flagship route covers the whole catalog and leads with the
  // hosted browser wallet.
  const btcLightning = listCryptoRouteProviders("btc-lightning");
  assert.equal(btcLightning.length, listProviders().length);
  assert.equal(btcLightning[0].provider.id, "rizful");
  assert.equal(getAsset("btc")?.route, "btc-lightning");
});

test("provider-data resolves payment wizard routes from asset and route inputs", () => {
  const cryptoRoutes = getPaymentWizardRoutes({ asset: "BTC" });
  const explicitRoutes = getPaymentWizardRoutes({ route: "BTC-Lightning" });

  assert.equal(cryptoRoutes.length, 1);
  assert.equal(cryptoRoutes[0].kind, "crypto");
  assert.equal(cryptoRoutes[0].route.id, "btc-lightning");
  assert.equal(cryptoRoutes[0].asset.symbol, "btc");
  assert.equal(cryptoRoutes[0].providers[0].provider.id, "rizful");

  assert.equal(explicitRoutes.length, 1);
  assert.equal(explicitRoutes[0].route.id, "btc-lightning");
  assert.equal(explicitRoutes[0].asset, undefined);

  // No inputs at all is the checkout's question, and btc-lightning is its
  // answer: both the no-arg and the empty-object call resolve to it.
  for (const defaulted of [getPaymentWizardRoutes(), getPaymentWizardRoutes({})]) {
    assert.equal(defaulted.length, 1);
    assert.equal(defaulted[0].route.id, "btc-lightning");
    assert.equal(defaulted[0].asset, undefined);
  }

  // An input that names something unresolvable still answers [] — the default
  // must never stand in for a route the caller asked for and did not get.
  assert.deepEqual(getPaymentWizardRoutes({ asset: "no-such-asset" }), []);
  assert.deepEqual(getPaymentWizardRoutes({ route: "no-such-route" }), []);
  // The registry ships fiat assets with no route; naming one is not "no inputs".
  for (const fiat of ["usd", "eur", "gbp"]) {
    assert.deepEqual(getPaymentWizardRoutes({ asset: fiat }), [], fiat);
  }
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
    cryptoVector.expected.provider_ids,
  );
});

test("provider-data filters providers conservatively", () => {
  // Sentinels: one of each provider kind, one US and one non-US provider.
  assert.equal(getProvider("strike")?.us, true);
  assert.equal(getProvider("sideshift")?.us, false);
  assert.equal(getProvider("rizful")?.kind, "browser wallet");
  assert.equal(getProvider("kraken")?.kind, "exchange");
  assert.equal(getProvider("zeus")?.kind, "mobile wallet");

  // Invariants over every provider, not a transcription of the catalog.
  for (const [id, provider] of Object.entries(providerRegistry.providers)) {
    assert.equal(provider.id, id, `${id}: key and id must agree`);
    assert.ok(
      typeof provider.kind === "string" && provider.kind.length > 0,
      `${id}: kind must be a non-empty string`,
    );
    assert.ok(
      typeof provider.us === "boolean" || provider.us === null,
      `${id}: us flag must be boolean or null (unknown)`,
    );
    assert.equal("mechanism" in provider, false, `${id}: mechanism was removed in v4`);
  }
  assert.equal(
    listProviders({ us: true }).every((provider) => provider.us === true),
    true,
  );
});

test("every provider tutorial is well-formed and resolvable", async () => {
  const tutorialImages = await loadPayTutorialImages();
  // Tutorial invariants replace the old caption/path transcriptions: captions
  // and step counts are registry content, but every step must be structurally
  // sound and its image must exist in the bundled asset map.
  for (const provider of Object.values(providerRegistry.providers)) {
    const tutorials = provider.tutorials ?? [];
    tutorials.forEach((tutorial, position) => {
      const label = `${provider.id} tutorial ${position + 1}`;
      assert.equal(tutorial.index, position + 1, `${label}: steps are sequential from 1`);
      assert.ok(
        typeof tutorial.caption === "string" && tutorial.caption.length > 0,
        `${label}: caption must be non-empty`,
      );
      assert.match(
        tutorial.path,
        new RegExp(`^assets/pay_tutorials/${provider.id}-\\d+\\.webp$`),
        `${label}: path names this provider's bundled webp`,
      );
      assert.ok(
        tutorialImages[tutorial.path] !== undefined,
        `${label}: ${tutorial.path} must resolve in the bundled tutorial map`,
      );
    });
    if (provider.icon_path !== undefined) {
      assert.ok(
        providerIconUrls[provider.icon_path] !== undefined,
        `${provider.id}: icon_path must resolve in the bundled icon map`,
      );
    }
  }
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
        providers: [{ provider: "missing-provider" }],
      },
      ...providerRegistry.crypto_routes.slice(1),
    ],
  };
  const result = validateRegistry(brokenRegistry);

  assert.equal(result.valid, false);
  assert.equal(
    result.errors.some((error) => error.includes("references missing provider missing-provider")),
    true,
  );
});

test("provider-data validation rejects duplicate route and provider entries", () => {
  const firstCryptoRoute = providerRegistry.crypto_routes[0];
  const firstDisqualifiedProvider = providerRegistry.disqualified_providers[0];

  const brokenRegistry = {
    ...providerRegistry,
    crypto_routes: [
      {
        ...firstCryptoRoute,
        providers: [
          firstCryptoRoute.providers[0],
          firstCryptoRoute.providers[0],
          ...firstCryptoRoute.providers.slice(1),
        ],
      },
      firstCryptoRoute,
      ...providerRegistry.crypto_routes.slice(1),
    ],
    disqualified_providers: [firstDisqualifiedProvider, ...providerRegistry.disqualified_providers],
  };

  const result = validateRegistry(brokenRegistry);

  assert.equal(result.valid, false);
  assert.equal(result.errors.includes("crypto route id btc-lightning is duplicated"), true);
  assert.equal(result.errors.includes("disqualified provider relai is duplicated"), true);
  assert.equal(
    result.errors.includes("crypto route btc-lightning references provider rizful more than once"),
    true,
  );
});

// The generated image tables, the registry, and the source directories pin each
// other: every registry icon_path and tutorial path has an image, every image is
// referenced (no dead bundle weight), and only .webp sits in either directory.
test("the generated image tables match the registry and the assets directories exactly", async () => {
  const { readdirSync } = await import("node:fs");
  const iconDir = "packages/js/provider-data/src/assets/provider-icons";
  const tutorialDir = "packages/js/provider-data/src/assets/pay_tutorials";
  for (const dir of [iconDir, tutorialDir]) {
    assert.ok(
      readdirSync(dir).every((file) => file.endsWith(".webp")),
      `${dir}: only .webp images ship`,
    );
  }
  const providers = Object.values(providerRegistry.providers);
  const iconPaths = [...new Set(providers.map((provider) => provider.icon_path))].sort();
  const tutorialPaths = providers
    .flatMap((provider) => (provider.tutorials ?? []).map((tutorial) => tutorial.path))
    .sort();
  assert.deepEqual(Object.keys(providerIconUrls).sort(), iconPaths);
  assert.deepEqual(
    readdirSync(iconDir)
      .map((file) => `assets/provider-icons/${file}`)
      .sort(),
    iconPaths,
  );
  const tutorialImages = await loadPayTutorialImages();
  assert.deepEqual(Object.keys(tutorialImages).sort(), tutorialPaths);
  assert.deepEqual(
    readdirSync(tutorialDir)
      .map((file) => `assets/pay_tutorials/${file}`)
      .sort(),
    tutorialPaths,
  );
  // The fetch manifest is internal tooling data and must not ship in assets.
  assert.ok(!readdirSync(iconDir).includes("manifest.json"));
});
