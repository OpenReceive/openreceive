import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createHelloFruitServer } from "../../examples/hello-fruit/server/node-express-react/src/server/create-server.ts";
import { createHelloFruitProductionServer } from "../../examples/hello-fruit/server/node-express-react/src/server/production.ts";
import { createHelloFruitStaticServer } from "../../examples/hello-fruit/server/static-html-small-api/src/server/create-server.ts";
import { createHelloFruitStaticProductionServer } from "../../examples/hello-fruit/server/static-html-small-api/src/server/production.ts";
import {
  createHelloFruitInvoiceDescription,
  formatHelloFruitBuyNowLabel,
  formatHelloFruitFiat,
  helloFruitDemoLabels
} from "../../examples/hello-fruit/shared/demo-formatting.ts";
import { quoteFiatToMsats } from "../../packages/js/core/src/index.ts";
import { GET as getNextDemoMetadata } from "../../examples/hello-fruit/server/nextjs-fullstack/src/app/demo-metadata.json/route.ts";
import { GET as getNextDocs } from "../../examples/hello-fruit/server/nextjs-fullstack/src/app/docs/route.ts";
import { POST as postNextCreateOrder } from "../../examples/hello-fruit/server/nextjs-fullstack/src/app/create_order/route.ts";
import { POST as postNextOrderStatus } from "../../examples/hello-fruit/server/nextjs-fullstack/src/app/order_status/route.ts";
import { GET as getNextSource } from "../../examples/hello-fruit/server/nextjs-fullstack/src/app/source/route.ts";
import getNextRobots, { dynamic as nextRobotsDynamic } from "../../examples/hello-fruit/server/nextjs-fullstack/src/app/robots.ts";
import getNextSitemap, { dynamic as nextSitemapDynamic } from "../../examples/hello-fruit/server/nextjs-fullstack/src/app/sitemap.ts";

const productPath = path.join(
  process.cwd(),
  "examples/hello-fruit/shared/product.json"
);
const fruitsPath = path.join(
  process.cwd(),
  "examples/hello-fruit/shared/fruits.json"
);
const canonicalDemoDataPath = path.join(
  process.cwd(),
  "spec/data/demo/fruits.json"
);
const demoServerDirs = [
  "examples/hello-fruit/server/node-express-react",
  "examples/hello-fruit/server/static-html-small-api",
  "examples/hello-fruit/server/nextjs-fullstack"
];

function createValidNwcUri(input = {}) {
  return (
    `nostr+walletconnect://${input.walletPubkey ?? "a".repeat(64)}` +
    `?relay=${encodeURIComponent(input.relay ?? "wss://relay.example.com")}` +
    `&secret=${input.secret ?? "b".repeat(64)}`
  );
}

test("Hello Fruit shared product keeps demo invoices low-value", () => {
  const product = JSON.parse(readFileSync(productPath, "utf8"));
  const fruits = JSON.parse(readFileSync(fruitsPath, "utf8"));

  assert.equal(product.schema_version, "0.1.0");
  assert.equal(product.name, "OpenReceive Demo: Buy A Fruit Sticker");
  assert.equal(product.description, "get a fruit sticker");
  assert.equal(product.invoice_expiry_seconds, 600);

  assert.deepEqual(
    fruits.fruits.map((fruit) => [fruit.id, fruit.fiat.currency, fruit.fiat.value]),
    [
      ["apple", "USD", "0.05"],
      ["banana", "USD", "0.10"],
      ["orange", "USD", "0.15"],
      ["pear", "USD", "0.20"]
    ]
  );
  assert.deepEqual(
    fruits.fruits.map((fruit) => quoteFiatToMsats({ fiat: fruit.fiat }).amount_msats),
    [100000, 200000, 300000, 400000]
  );
  for (const fruit of fruits.fruits) {
    assert.ok(quoteFiatToMsats({ fiat: fruit.fiat }).amount_msats <= 1000000);
  }
});

test("Hello Fruit shared data stays aligned with canonical demo data", () => {
  const canonical = JSON.parse(readFileSync(canonicalDemoDataPath, "utf8"));
  const product = JSON.parse(readFileSync(productPath, "utf8"));
  const fruits = JSON.parse(readFileSync(fruitsPath, "utf8"));

  assert.equal(product.schema_version, canonical.schema_version);
  assert.equal(fruits.schema_version, canonical.schema_version);
  assert.equal(product.product_id, canonical.product_id);
  assert.equal(fruits.product_id, canonical.product_id);
  assert.equal(product.name, canonical.name);
  assert.equal(product.description, canonical.description);
  assert.deepEqual(
    fruits.fruits.map(({ id, name, fiat }) => ({ id, name, fiat })),
    canonical.fruits
  );

  for (const fruit of fruits.fruits) {
    assert.equal(fruit.sticker, `stickers/${fruit.id}.svg`);
    assert.equal(
      existsSync(path.join(process.cwd(), "examples/hello-fruit/shared", fruit.sticker)),
      true,
      `${fruit.id}: sticker exists`
    );
  }
});

test("Hello Fruit demos share product display formatting", () => {
  assert.equal(formatHelloFruitFiat({ currency: "USD", value: "0.10" }), "$0.10");
  assert.equal(formatHelloFruitFiat({ currency: "EUR", value: "0.10" }), "0.10 EUR");
  assert.equal(formatHelloFruitBuyNowLabel({ currency: "USD", value: "0.10" }), "Add to cart ($0.10)");
  assert.equal(formatHelloFruitBuyNowLabel({ currency: "EUR", value: "0.10" }), "Add to cart (0.10 EUR)");
  assert.equal(helloFruitDemoLabels.createOrder, "Create order");
  assert.equal(helloFruitDemoLabels.creatingOrder, "Creating order...");
  assert.equal(helloFruitDemoLabels.createOrderError, "Could not create order.");
  assert.equal(
    createHelloFruitInvoiceDescription("Banana"),
    "Fruit sticker from OpenReceive demo: Banana"
  );
  assert.equal(
    createHelloFruitInvoiceDescription("Banana", { demoName: "Next.js" }),
    "Fruit sticker from OpenReceive Next.js demo: Banana"
  );
});

test("Hello Fruit React demos delegate checkout state to the React package", () => {
  const nodeClient = readFileSync(
    path.join(
      process.cwd(),
      "examples/hello-fruit/server/node-express-react/src/client/App.tsx"
    ),
    "utf8"
  );
  const nextClient = readFileSync(
    path.join(
      process.cwd(),
      "examples/hello-fruit/server/nextjs-fullstack/src/app/checkout-client.tsx"
    ),
    "utf8"
  );

  for (const [name, source] of [
    ["node-express-react", nodeClient],
    ["nextjs-fullstack", nextClient]
  ]) {
    assert.match(source, /<Checkout/);
    assert.match(source, /onPaid=/);
    assert.match(source, /lookupUrl="\/order_status"/);
    assert.match(source, /fetch\("\/create_order"/);
    assert.doesNotMatch(source, /createOpenReceiveLookupInvoiceFetcher/);
    assert.doesNotMatch(source, /lookupUrl="\/openreceive\/v1\/invoices\/lookup"/);
    assert.doesNotMatch(source, /lookupInvoice=\{lookupInvoice\}/);
    assert.doesNotMatch(source, /fetch\("\/openreceive\/v1\/invoices\/lookup"/);
    assert.doesNotMatch(source, /fetch\("\/openreceive\/v1\/invoices"/);
    assert.doesNotMatch(source, /payment_hash: state\.payment_hash/);
    assert.doesNotMatch(source, /new EventSource/);
    assert.doesNotMatch(source, /applyOpenReceiveInvoiceEvent/);
    assert.doesNotMatch(source, /parseOpenReceiveInvoiceEvent/);
    assert.doesNotMatch(source, /createCheckoutState/);
  }
});

test("Hello Fruit JS demos use package-owned QR and poll-only wiring", () => {
  const clientSources = [
    "examples/hello-fruit/server/node-express-react/src/client/App.tsx",
    "examples/hello-fruit/server/static-html-small-api/src/client/main.ts",
    "examples/hello-fruit/server/nextjs-fullstack/src/app/checkout-client.tsx"
  ];

  for (const sourcePath of clientSources) {
    const source = readFileSync(path.join(process.cwd(), sourcePath), "utf8");
    assert.doesNotMatch(source, /from "qrcode"/, `${sourcePath}: QR encoder must come from the UI package`);
    assert.doesNotMatch(source, /qrEncoder/, `${sourcePath}: demo must not pass a local QR encoder`);
  }

  assert.equal(
    existsSync(path.join(
      process.cwd(),
      "examples/hello-fruit/server/nextjs-fullstack/src/qrcode.d.ts"
    )),
    false
  );

  for (const demoDir of demoServerDirs) {
    const packageJson = JSON.parse(
      readFileSync(path.join(process.cwd(), demoDir, "package.json"), "utf8")
    );
    const config = readFileSync(
      path.join(process.cwd(), demoDir, "openreceive.config.mjs"),
      "utf8"
    );
    const compose = readFileSync(path.join(process.cwd(), demoDir, "compose.yml"), "utf8");

    assert.equal(packageJson.dependencies.qrcode, undefined, `${demoDir}: qrcode is package-owned`);
    assert.match(packageJson.scripts.dev, /require-openreceive-nwc\.ts/);
    assert.match(packageJson.scripts.start, /require-openreceive-nwc\.ts/);
    assert.equal(packageJson.scripts["openreceive:worker"], undefined);
    assert.equal(packageJson.scripts["openreceive:poll"], "openreceive poll --once");
    assert.match(config, /createHelloFruitOpenReceive/);
    assert.match(config, /export default openreceive/);
    assert.doesNotMatch(config, /nostr\+walletconnect:\/\//);
    assert.doesNotMatch(compose, /openreceive-worker/);
    assert.doesNotMatch(compose, /command:\s+\["npm", "run", "openreceive:worker"\]/);
  }
});

test("Hello Fruit Node demo creates orders from cart before rendering checkout", () => {
  const source = readFileSync(
    path.join(
      process.cwd(),
      "examples/hello-fruit/server/node-express-react/src/client/App.tsx"
    ),
    "utf8"
  );

  assert.match(source, /function startOver\(\)/);
  assert.match(source, /addSelectedFruitToCart/);
  assert.match(source, /async function createOrder\(\)/);
  assert.match(source, /fetch\("\/create_order"/);
  assert.match(source, /lookupUrl="\/order_status"/);
  assert.match(source, /setCart\(\{\}\)/);
  assert.match(source, /setOrder\(null\)/);
  assert.match(source, /setInvoice\(null\)/);
  assert.match(source, /setFruitId\(initialFruitId\)/);
  assert.match(source, /invoice === null \? \(/);
  assert.match(source, /onStartOver=\{startOver\}/);
  assert.match(source, />\s*Start over\s*</);
  assert.match(source, /crypto\?\.randomUUID/);
  assert.doesNotMatch(source, /createInvoice as requestInvoice/);
});

test("Hello Fruit Next.js demo resets expired checkout from Start over", () => {
  const source = readFileSync(
    path.join(
      process.cwd(),
      "examples/hello-fruit/server/nextjs-fullstack/src/app/checkout-client.tsx"
    ),
    "utf8"
  );

  assert.match(source, /function startOver\(\)/);
  assert.match(source, /async function createOrder\(\)/);
  assert.match(source, /fetch\("\/create_order"/);
  assert.match(source, /lookupUrl="\/order_status"/);
  assert.match(source, /setCart\(\{\}\)/);
  assert.match(source, /setOrder\(undefined\)/);
  assert.match(source, /setCheckout\(undefined\)/);
  assert.match(source, /setStatus\("idle"\)/);
  assert.match(source, /onStartOver=\{startOver\}/);
  assert.doesNotMatch(source, /createInvoice as requestInvoice/);
});

test("Hello Fruit browser demos consume shared product display helpers", () => {
  const sources = [
    "examples/hello-fruit/server/node-express-react/src/client/App.tsx",
    "examples/hello-fruit/server/nextjs-fullstack/src/app/checkout-client.tsx",
    "examples/hello-fruit/server/static-html-small-api/src/client/main.ts"
  ].map((relativePath) => [
    relativePath,
    readFileSync(path.join(process.cwd(), relativePath), "utf8")
  ]);

  for (const [relativePath, source] of sources) {
    assert.match(source, /formatHelloFruitFiat/,
      `${relativePath}: uses shared fiat display helper`);
    assert.match(source, /formatHelloFruitBuyNowLabel/,
      `${relativePath}: uses shared buy-now label helper`);
    assert.match(source, /helloFruitDemoLabels/,
      `${relativePath}: uses shared demo checkout labels`);
    assert.doesNotMatch(source, /function formatFiat/,
      `${relativePath}: must not duplicate fiat display formatting`);
    assert.doesNotMatch(source, /Fruit sticker from OpenReceive .*demo: \$\{/,
      `${relativePath}: must not duplicate invoice description templates`);
    assert.doesNotMatch(source, /"Could not create invoice\."/,
      `${relativePath}: must not duplicate invoice error fallback`);
    assert.doesNotMatch(source, /"Creating invoice\.\.\."/,
      `${relativePath}: must not duplicate invoice creation label`);
    assert.doesNotMatch(source, /"Could not create order\."/,
      `${relativePath}: must not duplicate order error fallback`);
    assert.doesNotMatch(source, /"Creating order\.\.\."/,
      `${relativePath}: must not duplicate order creation label`);
  }
});

test("Hello Fruit static demo delegates checkout state to the web component", () => {
  const source = readFileSync(
    path.join(
      process.cwd(),
      "examples/hello-fruit/server/static-html-small-api/src/client/main.ts"
    ),
    "utf8"
  );
  const html = readFileSync(
    path.join(
      process.cwd(),
      "examples/hello-fruit/server/static-html-small-api/index.html"
    ),
    "utf8"
  );

  assert.match(source, /defineOpenReceiveElements/);
  assert.match(source, /createCheckoutShell/);
  assert.match(source, /createOpenReceiveThemeToggleElement/);
  assert.match(source, /@openreceive\/elements\/styles\.css/);
  assert.match(source, /rootSelector: "\.page"/);
  assert.match(source, /checkoutSelector: "openreceive-checkout"/);
  assert.doesNotMatch(html, /<openreceive-theme-toggle/);
  assert.doesNotMatch(html, /root-selector="\.page"/);
  assert.doesNotMatch(html, /checkout-selector="openreceive-checkout"/);
  assert.doesNotMatch(source, /syncOpenReceiveStoredThemeControls/);
  assert.doesNotMatch(source, /toggleOpenReceiveStoredThemeControls/);
  assert.doesNotMatch(source, /theme-toggle/);
  assert.doesNotMatch(source, /createCheckoutElement\(/);
  assert.doesNotMatch(source, /document\.createElement\("openreceive-checkout"\)/);
  assert.doesNotMatch(source, /document\.createElement\("openreceive-theme-toggle"\)/);
  assert.doesNotMatch(source, /createCheckoutElementAttributes/);
  assert.doesNotMatch(source, /createCheckoutElementListeners/);
  assert.doesNotMatch(source, /createOpenReceiveThemeToggleElementAttributes/);
  assert.doesNotMatch(source, /addEventListener\(name/);
  assert.doesNotMatch(source, /setAttribute\(name/);
  assert.doesNotMatch(source, /addEventListener\("openreceive-/);
  assert.doesNotMatch(source, /new EventSource/);
  assert.doesNotMatch(source, /parseOpenReceiveInvoiceEvent/);
  assert.doesNotMatch(source, /setInterval/);
  assert.doesNotMatch(source, /localStorage/);
});

test("Hello Fruit browser demos consume shared theme model", () => {
  const nodeClient = readFileSync(
    path.join(
      process.cwd(),
      "examples/hello-fruit/server/node-express-react/src/client/App.tsx"
    ),
    "utf8"
  );
  const nextClient = readFileSync(
    path.join(
      process.cwd(),
      "examples/hello-fruit/server/nextjs-fullstack/src/app/checkout-client.tsx"
    ),
    "utf8"
  );
  const staticClient = readFileSync(
    path.join(
      process.cwd(),
      "examples/hello-fruit/server/static-html-small-api/src/client/main.ts"
    ),
    "utf8"
  );

  for (const [name, source] of [
    ["node-express-react", nodeClient],
    ["nextjs-fullstack", nextClient]
  ]) {
    assert.match(source, /ThemeScope/, `${name}: uses package theme scope`);
    assert.match(source, /themeToggle/, `${name}: enables package theme toggle`);
    assert.match(source, /topbarClassName="topbar"/, `${name}: styles package theme toggle shell`);
    assert.doesNotMatch(source, /useOpenReceiveTheme/, `${name}: must not wire theme hook locally`);
    assert.doesNotMatch(source, /OpenReceiveThemeToggle/, `${name}: must not wire theme button locally`);
    assert.doesNotMatch(source, /\.\.\.theme\.attributes/, `${name}: must not apply theme attrs locally`);
    assert.doesNotMatch(source, /"Light mode"/, `${name}: must not own theme toggle label`);
    assert.doesNotMatch(source, /"Dark mode"/, `${name}: must not own theme toggle label`);
  }

  assert.doesNotMatch(staticClient, /syncOpenReceiveStoredThemeControls/);
  assert.doesNotMatch(staticClient, /toggleOpenReceiveStoredThemeControls/);
  assert.doesNotMatch(staticClient, /toggleOpenReceiveStoredThemePreference/);
  assert.doesNotMatch(staticClient, /applyOpenReceiveThemeAttributes/);
  assert.doesNotMatch(staticClient, /applyCheckoutThemeAttributes/);
  assert.doesNotMatch(staticClient, /theme\.toggleLabel/);
  assert.doesNotMatch(staticClient, /Object\.entries\(theme\.attributes\)/);
  assert.doesNotMatch(staticClient, /setAttribute\("data-theme"/);
  assert.doesNotMatch(staticClient, /setAttribute\("data-openreceive-theme"/);
  assert.doesNotMatch(staticClient, /"Light mode"/);
  assert.doesNotMatch(staticClient, /"Dark mode"/);
});

test("Frontend UI packages delegate checkout lifecycle to browser helpers", () => {
  const reactSource = readFileSync(
    path.join(process.cwd(), "packages/js/react/src/index.ts"),
    "utf8"
  );
  const elementsSource = readFileSync(
    path.join(process.cwd(), "packages/js/elements/src/index.ts"),
    "utf8"
  );

  for (const [name, source] of [
    ["react", reactSource],
    ["elements", elementsSource]
  ]) {
    assert.match(source, /createCheckoutController/,
      `${name}: uses browser checkout controller`);
    assert.match(source, /createCheckoutStatusModel/,
      `${name}: uses browser checkout status display model`);
    assert.doesNotMatch(source, /new CheckoutWatcher/,
      `${name}: must not construct checkout watcher locally`);
    assert.doesNotMatch(source, /createOpenReceiveLookupInvoiceFetcher/,
      `${name}: must not construct lookup fetcher locally`);
    assert.doesNotMatch(source, /new EventSource/, `${name}: must not own SSE wiring`);
    assert.doesNotMatch(source, /setInterval\(/, `${name}: must not own polling or countdown intervals`);
    assert.doesNotMatch(source, /fetch\(lookupUrl/,
      `${name}: must not own lookup POST wiring`);
    assert.doesNotMatch(source, /state\.expires_at - currentUnixSeconds/,
      `${name}: must not recompute checkout countdown locally`);
    assert.doesNotMatch(source, /transaction_state !== "settled"/,
      `${name}: must not own waiting-state settlement rule`);
    assert.doesNotMatch(source, /formatOpenReceiveCountdown/,
      `${name}: must not format checkout countdown labels locally`);
    assert.doesNotMatch(source, /getOpenReceivePaymentStatusText/,
      `${name}: must not compose checkout status text locally`);
    assert.doesNotMatch(source, /shouldCheckoutShowWaiting/,
      `${name}: must not compose checkout waiting state locally`);
    assert.doesNotMatch(source, /"Invoice expires in"/,
      `${name}: must not own countdown prefix text`);
  }
});

test("Frontend UI packages consume shared transient feedback timing", () => {
  const reactSource = readFileSync(
    path.join(process.cwd(), "packages/js/react/src/index.ts"),
    "utf8"
  );
  const elementsSource = readFileSync(
    path.join(process.cwd(), "packages/js/elements/src/index.ts"),
    "utf8"
  );

  for (const [name, source] of [
    ["react", reactSource],
    ["elements", elementsSource]
  ]) {
    assert.match(source, /createOpenReceiveTransientFeedbackController/,
      `${name}: uses browser transient feedback controller`);
    assert.doesNotMatch(source, /globalThis\.setTimeout/,
      `${name}: must not own copy-feedback timers`);
    assert.doesNotMatch(source, /setCopied\(false\)/,
      `${name}: must not locally reset copied state`);
    assert.doesNotMatch(source, /setCopiedProviderId\(null\)/,
      `${name}: must not locally reset provider copied state`);
  }
});

test("Frontend UI packages consume shared checkout labels", () => {
  const reactSource = readFileSync(
    path.join(process.cwd(), "packages/js/react/src/index.ts"),
    "utf8"
  );
  const elementsSource = readFileSync(
    path.join(process.cwd(), "packages/js/elements/src/index.ts"),
    "utf8"
  );

  for (const [name, source] of [
    ["react", reactSource],
    ["elements", elementsSource]
  ]) {
    assert.match(source, /openReceiveCheckoutLabels/, `${name}: uses shared labels`);
    assert.match(source, /createCheckoutProviderCopyEvent/,
      `${name}: uses shared provider-copy event helper`);
    assert.doesNotMatch(source, /"Pay this invoice"/, `${name}: wizard title is package-shared`);
    assert.doesNotMatch(source, /"Copy BOLT11"/, `${name}: copy label is package-shared`);
    assert.doesNotMatch(source, /"Waiting for payment"/, `${name}: status label is package-shared`);
    assert.doesNotMatch(source, /"openreceive-provider-copy"/,
      `${name}: provider-copy event name is browser-shared`);
    assert.doesNotMatch(source, /detail: \{ providerId \}/,
      `${name}: provider-copy event detail is browser-shared`);
    assert.doesNotMatch(source, /`Open \$\{/, `${name}: provider action label is package-shared`);
    assert.doesNotMatch(source, /"Lightning Network"/, `${name}: route network label is package-shared`);
    assert.doesNotMatch(source, /"Choose a country"/, `${name}: country prompt is package-shared`);
    assert.doesNotMatch(source, /"No providers found for this country yet\\."/,
      `${name}: empty state label is package-shared`);
  }
});

test("Frontend UI packages consume shared checkout data attributes", () => {
  const reactSource = readFileSync(
    path.join(process.cwd(), "packages/js/react/src/index.ts"),
    "utf8"
  );
  const elementsSource = readFileSync(
    path.join(process.cwd(), "packages/js/elements/src/index.ts"),
    "utf8"
  );

  for (const [name, source] of [
    ["react", reactSource],
    ["elements", elementsSource]
  ]) {
    assert.match(source, /OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES/,
      `${name}: uses browser-owned checkout data attributes`);
    assert.doesNotMatch(source, /"data-openreceive-qr"/,
      `${name}: must not spell QR data attribute locally`);
    assert.doesNotMatch(source, /"data-openreceive-theme-toggle"/,
      `${name}: must not spell theme-toggle data attribute locally`);
  }
  assert.match(elementsSource, /OPENRECEIVE_CHECKOUT_DATA_SELECTORS/,
    "elements: uses browser-owned checkout data selectors");
  assert.doesNotMatch(reactSource, /"data-openreceive-checkout"/,
    "react: must not spell checkout root data attribute locally");
  assert.doesNotMatch(reactSource, /"data-openreceive-actions"/,
    "react: must not spell checkout actions data attribute locally");
  assert.doesNotMatch(reactSource, /"data-openreceive-state"/,
    "react: must not spell checkout state data attribute locally");
  assert.doesNotMatch(elementsSource, /querySelector\("\[data-openreceive-qr\]"\)/,
    "elements: must not hard-code checkout QR selector");
});

test("Elements consume shared custom-element attribute contracts", () => {
  const elementsSource = readFileSync(
    path.join(process.cwd(), "packages/js/elements/src/index.ts"),
    "utf8"
  );

  assert.match(elementsSource, /OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES/,
    "elements: uses browser-owned checkout element attributes");
  assert.match(elementsSource, /OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES/,
    "elements: uses browser-owned theme-toggle element attributes");
  assert.match(elementsSource, /parseOpenReceiveOptionalInteger/,
    "elements: parses numeric attributes through browser helpers");
  assert.match(elementsSource, /parseOpenReceiveBooleanAttribute/,
    "elements: parses boolean attributes through browser helpers");
  assert.match(elementsSource, /parseOpenReceiveResolvedTheme/,
    "elements: parses checkout theme attributes through browser helpers");
  assert.match(elementsSource, /parseOpenReceiveThemePreference/,
    "elements: parses theme preference attributes through browser helpers");
  assert.doesNotMatch(elementsSource, /getAttribute\("invoice-id"\)/,
    "elements: must not hard-code invoice-id reads");
  assert.doesNotMatch(elementsSource, /getAttribute\("lookup-url"\)/,
    "elements: must not hard-code lookup-url reads");
  assert.doesNotMatch(elementsSource, /getAttribute\("root-selector"\)/,
    "elements: must not hard-code theme root selector reads");
  assert.doesNotMatch(elementsSource, new RegExp(`setAttributeIfChanged\\("transaction-${"state"}`),
    "elements: must not hard-code raw lifecycle-state writes");
  assert.doesNotMatch(elementsSource, /setAttributeIfChanged\("theme"/,
    "elements: must not hard-code theme writes");
  assert.doesNotMatch(elementsSource, /function parseOptionalInteger/,
    "elements: must not own numeric attribute parsing");
  assert.doesNotMatch(elementsSource, /function parseTheme/,
    "elements: must not own theme attribute parsing");
  assert.doesNotMatch(elementsSource, /function parseBooleanAttribute/,
    "elements: must not own boolean attribute parsing");
});

test("Elements consume shared theme-toggle event contract", () => {
  const elementsSource = readFileSync(
    path.join(process.cwd(), "packages/js/elements/src/index.ts"),
    "utf8"
  );

  assert.match(elementsSource, /createOpenReceiveThemeChangeEvent/,
    "elements: dispatches theme changes through browser event helper");
  assert.doesNotMatch(elementsSource, /"openreceive-theme-change"/,
    "elements: must not hard-code theme-change event names");
  assert.doesNotMatch(elementsSource, /resolvedTheme: nextTheme\.resolvedTheme/,
    "elements: must not compose theme-change event details locally");
});

test("Elements consume shared checkout event constructors", () => {
  const elementsSource = readFileSync(
    path.join(process.cwd(), "packages/js/elements/src/index.ts"),
    "utf8"
  );

  assert.match(elementsSource, /createCheckoutActionEvent/,
    "elements: dispatches copy/open events through browser helpers");
  assert.match(elementsSource, /createCheckoutStateEvent/,
    "elements: dispatches state events through browser helpers");
  assert.match(elementsSource, /createCheckoutErrorEvent/,
    "elements: dispatches error events through browser helpers");
  assert.doesNotMatch(elementsSource, /new CustomEvent\(OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS/,
    "elements: must not construct checkout custom events locally");
  assert.doesNotMatch(elementsSource, /detail: \{ state \}/,
    "elements: must not compose checkout state event details locally");
});

test("Elements consume shared web-component shadow part contracts", () => {
  const elementsSource = readFileSync(
    path.join(process.cwd(), "packages/js/elements/src/index.ts"),
    "utf8"
  );

  assert.match(elementsSource, /OPENRECEIVE_CHECKOUT_ELEMENT_PARTS/,
    "elements: renders checkout shadow parts from browser constants");
  assert.match(elementsSource, /OPENRECEIVE_CHECKOUT_ELEMENT_PART_SELECTORS/,
    "elements: binds checkout shadow actions through browser selectors");
  assert.match(elementsSource, /OPENRECEIVE_THEME_TOGGLE_ELEMENT_PARTS/,
    "elements: renders theme-toggle shadow parts from browser constants");
  assert.match(elementsSource, /OPENRECEIVE_THEME_TOGGLE_ELEMENT_PART_SELECTORS/,
    "elements: binds theme-toggle actions through browser selectors");
  assert.doesNotMatch(elementsSource, /querySelector\('\[part="copy"\]'\)/,
    "elements: must not hard-code copy part selectors");
  assert.doesNotMatch(elementsSource, /querySelector\("button"\)/,
    "elements: must not hard-code theme-toggle button selectors");
});

test("Frontend UI packages consume shared checkout display model", () => {
  const reactSource = readFileSync(
    path.join(process.cwd(), "packages/js/react/src/index.ts"),
    "utf8"
  );
  const elementsSource = readFileSync(
    path.join(process.cwd(), "packages/js/elements/src/index.ts"),
    "utf8"
  );

  for (const [name, source] of [
    ["react", reactSource],
    ["elements", elementsSource]
  ]) {
    assert.match(source, /createCheckoutDisplayModel/,
      `${name}: uses browser-owned checkout display labels`);
    assert.doesNotMatch(source, /function shortHash/,
      `${name}: must not own payment hash shortening`);
    assert.doesNotMatch(source, /assertDisplaySafeInvoice/,
      `${name}: must not own display invoice safety checks`);
    assert.doesNotMatch(source, /paymentHashLabel: shortHash/,
      `${name}: must not build hash labels locally`);
  }
});

test("Frontend UI packages consume shared checkout display state conversion", () => {
  const reactSource = readFileSync(
    path.join(process.cwd(), "packages/js/react/src/index.ts"),
    "utf8"
  );
  const elementsSource = readFileSync(
    path.join(process.cwd(), "packages/js/elements/src/index.ts"),
    "utf8"
  );

  for (const [name, source] of [
    ["react", reactSource],
    ["elements", elementsSource]
  ]) {
    assert.match(source, /createCheckoutStateFromDisplayData/,
      `${name}: creates checkout state from browser-owned display conversion`);
    assert.match(source, /createCheckoutSnapshotFromDisplayData/,
      `${name}: creates live snapshots from browser-owned display conversion`);
    assert.doesNotMatch(source, /function toCheckoutSnapshot/,
      `${name}: must not own display-to-snapshot mapping`);
    assert.doesNotMatch(source, /invoice_id is required for checkout state/,
      `${name}: must not own checkout-state invoice id validation`);
    assert.doesNotMatch(source, /invoice_id: options\.invoice_id/,
      `${name}: must not build React-style checkout snapshots locally`);
    assert.doesNotMatch(source, /function currentUnixSeconds/,
      `${name}: must not own checkout countdown clock helpers`);
  }
});

test("Elements consumes shared display HTML escaping", () => {
  const elementsSource = readFileSync(
    path.join(process.cwd(), "packages/js/elements/src/index.ts"),
    "utf8"
  );

  assert.match(elementsSource, /escapeOpenReceiveHtml/,
    "elements: escapes rendered HTML through browser helper");
  assert.doesNotMatch(elementsSource, /function escapeHtml/,
    "elements: must not own HTML escaping implementation");
  assert.doesNotMatch(elementsSource, /replaceAll\("&", "&amp;"\)/,
    "elements: must not duplicate HTML escape rules");
});

test("Frontend UI packages consume shared wizard route display model", () => {
  const reactSource = readFileSync(
    path.join(process.cwd(), "packages/js/react/src/index.ts"),
    "utf8"
  );
  const elementsSource = readFileSync(
    path.join(process.cwd(), "packages/js/elements/src/index.ts"),
    "utf8"
  );

  for (const [name, source] of [
    ["react", reactSource],
    ["elements", elementsSource]
  ]) {
    assert.match(source, /createOpenReceiveWizardRouteDisplays/,
      `${name}: uses shared wizard route display model`);
    assert.doesNotMatch(source, /OPENRECEIVE_PROVIDER_PREVIEW_LIMIT/,
      `${name}: must not own provider preview slicing`);
    assert.doesNotMatch(source, /route\.kind/,
      `${name}: must not own route heading decisions`);
    assert.doesNotMatch(source, /route\.providers\.slice/,
      `${name}: must not slice provider previews locally`);
    assert.doesNotMatch(source, /entry\.flagship/,
      `${name}: must not own recommended provider labels`);
    assert.doesNotMatch(source, /entry\.provider/,
      `${name}: must not own raw provider display fields`);
    assert.doesNotMatch(source, /getCheckoutProviderMechanismLabel/,
      `${name}: must not compose provider badges locally`);
    assert.doesNotMatch(source, /getCheckoutProviderOpenLabel/,
      `${name}: must not compose provider links locally`);
    assert.doesNotMatch(source, /getCheckoutProviderUsBadge/,
      `${name}: must not compose provider US badges locally`);
  }
});

test("Frontend UI packages consume shared wizard selection model", () => {
  const reactSource = readFileSync(
    path.join(process.cwd(), "packages/js/react/src/index.ts"),
    "utf8"
  );
  const elementsSource = readFileSync(
    path.join(process.cwd(), "packages/js/elements/src/index.ts"),
    "utf8"
  );

  for (const [name, source] of [
    ["react", reactSource],
    ["elements", elementsSource]
  ]) {
    assert.match(source, /createOpenReceivePaymentWizardModel/,
      `${name}: derives wizard view model from browser helper`);
    assert.match(source, /updateOpenReceivePaymentWizardSelection|createOpenReceivePaymentWizardController/,
      `${name}: updates wizard selection through browser-owned selection logic`);
    assert.doesNotMatch(source, /setSelectedMethod/,
      `${name}: must not own method selection transitions`);
    assert.doesNotMatch(source, /setSelectedCountryCode/,
      `${name}: must not own country selection transitions`);
  }
  assert.match(elementsSource, /OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES/,
    "elements: renders wizard DOM attributes from browser constants");
  assert.match(elementsSource, /OPENRECEIVE_PAYMENT_WIZARD_SELECTORS/,
    "elements: binds wizard DOM events through browser selectors");
  assert.match(elementsSource, /parseOpenReceivePaymentMethod/,
    "elements: parses wizard methods through browser helper");
  assert.match(elementsSource, /parseOpenReceiveRegion/,
    "elements: parses wizard regions through browser helper");
  assert.doesNotMatch(elementsSource, /querySelectorAll\("\[data-or-/,
    "elements: must not hard-code wizard query selectors");
  assert.doesNotMatch(elementsSource, /getAttribute\("data-or-/,
    "elements: must not hard-code wizard attribute reads");
});

test("Frontend UI packages consume shared country dropdown model", () => {
  const reactSource = readFileSync(
    path.join(process.cwd(), "packages/js/react/src/index.ts"),
    "utf8"
  );
  const elementsSource = readFileSync(
    path.join(process.cwd(), "packages/js/elements/src/index.ts"),
    "utf8"
  );

  assert.match(reactSource, /model\.countryDisplays/,
    "react: renders countries from browser display model");
  assert.match(reactSource, /renderCountrySelect/,
    "react: renders a package-owned country dropdown");
  assert.doesNotMatch(reactSource, /projectMapPoint/,
    "react: must not re-project country map pins");
  assert.doesNotMatch(reactSource, /geoNaturalEarth1/,
    "react: must not own country map projection");
  assert.doesNotMatch(reactSource, /world-atlas/,
    "react: must not own country map atlas data");
  assert.doesNotMatch(reactSource, /topojson-client/,
    "react: must not own country map feature extraction");
  assert.match(elementsSource, /model\.countryDisplays/,
    "elements: renders countries from browser display model");
  assert.match(elementsSource, /renderCountrySelectHtml/,
    "elements: renders a package-owned country dropdown");
  assert.doesNotMatch(elementsSource, /part="country-map"/,
    "elements: must not render the old country map");
  for (const [name, source] of [
    ["react", reactSource],
    ["elements", elementsSource]
  ]) {
    assert.doesNotMatch(source, /openReceiveCountryPins/,
      `${name}: must not own country map pin data`);
    assert.doesNotMatch(source, /openReceiveRegionLabels/,
      `${name}: must not own region display labels`);
    assert.doesNotMatch(source, /getOpenReceiveCoverageLabel/,
      `${name}: must not compose country coverage labels locally`);
    assert.doesNotMatch(source, /country\.currency.*country\.coverage/s,
      `${name}: must not compose country meta labels locally`);
  }
});

test("Frontend UI packages consume shared payment icon helpers", () => {
  const reactSource = readFileSync(
    path.join(process.cwd(), "packages/js/react/src/index.ts"),
    "utf8"
  );
  const elementsSource = readFileSync(
    path.join(process.cwd(), "packages/js/elements/src/index.ts"),
    "utf8"
  );

  for (const [name, source] of [
    ["react", reactSource],
    ["elements", elementsSource]
  ]) {
    assert.match(source, /getOpenReceivePaymentMethodIcon/,
      `${name}: method icons come from the browser package`);
    assert.match(source, /createOpenReceiveWizardRouteAssetDisplays/,
      `${name}: route asset rows come from the browser package`);
    assert.doesNotMatch(source, /getOpenReceiveRouteIcon/,
      `${name}: must not build route icon rows locally`);
    assert.doesNotMatch(source, /getOpenReceiveRouteNetworkLabel/,
      `${name}: must not build route subtitles locally`);
    assert.doesNotMatch(source, /asset\.route \?\? asset\.symbol/,
      `${name}: must not resolve route ids locally`);
    assert.doesNotMatch(source, /new URL\("\.\/assets\/icons/,
      `${name}: must not own checkout icon asset URLs`);
  }
});

test("Hello Fruit JS demos set up package-owned invoice persistence", () => {
  const helper = readFileSync(
    path.join(process.cwd(), "examples/hello-fruit/shared/openreceive-store.ts"),
    "utf8"
  );
  const postgresStore = readFileSync(
    path.join(process.cwd(), "packages/js/node/src/postgres-store.ts"),
    "utf8"
  );
  assert.match(helper, /resolveOpenReceiveStore/);
  assert.match(helper, /OPENRECEIVE_STORE/);
  assert.match(helper, /OPENRECEIVE_NAMESPACE/);
  assert.doesNotMatch(helper, /DATABASE_URL/);
  assert.doesNotMatch(helper, /OPENRECEIVE_DATABASE_SCHEMA_VERSION/);
  assert.doesNotMatch(helper, /OPENRECEIVE_POSTGRES_MIGRATION_SQL/);
  assert.doesNotMatch(helper, /OpenReceivePostgresQueryClient/);
  assert.doesNotMatch(helper, /new InMemoryInvoiceKvStore\(\)/);
  assert.doesNotMatch(helper, /createOpenReceivePostgresKvStoreFromPool/);
  assert.doesNotMatch(helper, /createOpenReceiveSqliteKvStore/);
  assert.doesNotMatch(helper, /node:sqlite/);
  assert.match(postgresStore, /createOpenReceivePostgresKvStoreFromPool/);
  assert.match(postgresStore, /data JSONB NOT NULL/);
  assert.match(postgresStore, /openreceive_meta/);

  for (const demoDir of demoServerDirs) {
    const packageJson = JSON.parse(
      readFileSync(path.join(process.cwd(), demoDir, "package.json"), "utf8")
    );
    const compose = readFileSync(path.join(process.cwd(), demoDir, "compose.yml"), "utf8");

    assert.equal(packageJson.dependencies.pg, "^8.22.0", `${demoDir}: pg dependency`);
    assert.match(compose, /OPENRECEIVE_STORE:\s+postgres:\/\/openreceive:openreceive@openreceive-postgres:5432\/openreceive/);
    assert.match(compose, /OPENRECEIVE_NAMESPACE:\s+hello_fruit_/);
    assert.doesNotMatch(compose, /DATABASE_URL/);
    assert.match(compose, /openreceive-postgres:/);
    assert.match(compose, /image:\s+postgres:17-alpine/);
    assert.match(compose, /openreceive-postgres-data:\/var\/lib\/postgresql\/data/);
  }

  for (const sourcePath of [
    "examples/hello-fruit/server/node-express-react/src/server/create-server.ts",
    "examples/hello-fruit/server/static-html-small-api/src/server/create-server.ts",
    "examples/hello-fruit/server/nextjs-fullstack/src/server/openreceive.ts"
  ]) {
    const source = readFileSync(path.join(process.cwd(), sourcePath), "utf8");
    assert.match(source, /createHelloFruitOpenReceiveKvStore/);
    assert.match(source, /await createHelloFruitOpenReceiveKvStore/);
    assert.doesNotMatch(source, /new InMemoryInvoiceStore\(\)/);
    assert.doesNotMatch(source, /OPENRECEIVE_POSTGRES_MIGRATION_SQL/);
    assert.doesNotMatch(source, /OPENRECEIVE_DATABASE_SCHEMA_VERSION/);
  }

  for (const sourcePath of [
    "examples/hello-fruit/server/node-express-react/openreceive.config.mjs",
    "examples/hello-fruit/server/static-html-small-api/openreceive.config.mjs",
    "examples/hello-fruit/server/nextjs-fullstack/openreceive.config.mjs"
  ]) {
    const source = readFileSync(path.join(process.cwd(), sourcePath), "utf8");
    assert.match(source, /await createHelloFruitOpenReceive/);
  }
});

test("Next.js demo owns merchant route handling and calls OpenReceive service methods", () => {
  const source = readFileSync(
    path.join(
      process.cwd(),
      "examples/hello-fruit/server/nextjs-fullstack/src/server/openreceive.ts"
    ),
    "utf8"
  );

  assert.match(source, /createOpenReceive/);
  assert.match(source, /createOrderResponse/);
  assert.match(source, /orderStatusResponse/);
  assert.match(source, /createHelloFruitCreateOrderResult/);
  assert.match(source, /openreceive\.createInvoice/);
  assert.match(source, /openreceive\.lookupInvoice/);
  assert.match(source, /readRequiredHelloFruitNwcConnectionString/);
  assert.doesNotMatch(source, /dispatchOpenReceiveRoute/);
  assert.doesNotMatch(source, /matchOpenReceiveRoute/);
  assert.doesNotMatch(source, /@openreceive\/next/);
  assert.doesNotMatch(source, /createNwcReceiveClient/);
  assert.doesNotMatch(source, /createOpenReceiveNextRuntime/);
  assert.doesNotMatch(source, /dispatchOpenReceiveNextNoWalletRoute/);
  assert.doesNotMatch(source, /class CapturedResponse/);
  assert.doesNotMatch(source, /ExpressLikeRequest/);
  assert.doesNotMatch(source, /ReadableStream<Uint8Array>/);
  assert.doesNotMatch(source, /formatSseEvent/);
  assert.doesNotMatch(source, /parseLastEventId/);
});

test("Rails React skeleton is explicitly quarantined and does not claim active Rails demo identity", () => {
  const railsReactDir = path.join(
    process.cwd(),
    "examples/hello-fruit/server/rails-react"
  );
  const files = [
    "README.md",
    "Dockerfile",
    "Makefile",
    "compose.yml",
    "compose.override.yml.example",
    "app/controllers/hello_fruit_controller.rb",
    "app/views/hello_fruit/index.html.erb",
    "config/application.rb",
    "config/environment.rb",
    "config/initializers/openreceive.rb"
  ];

  const combined = files
    .map((relativePath) => readFileSync(path.join(railsReactDir, relativePath), "utf8"))
    .join("\n");

  assert.match(combined, /quarantined/i);
  assert.match(combined, /rails-react/);
  assert.match(combined, /OpenReceive::Rails\.resolve_invoice_store/);
  assert.match(combined, /ENV\.fetch\("OPENRECEIVE_NWC"/);
  assert.match(combined, /OpenReceive\.parse_nwc_uri/);
  assert.doesNotMatch(combined, /OpenReceive::UnavailableReceiveClient/);
  assert.doesNotMatch(combined, /create_active_record_invoice_store/);
  assert.doesNotMatch(combined, /rails-hotwire/);
  assert.doesNotMatch(combined, /Rails Hotwire/);
  assert.doesNotMatch(combined, /demo-rails-hotwire/);
  assert.doesNotMatch(combined, /HelloFruitRailsHotwire/);
});

test("Hello Fruit server demos keep secret-safe local setup docs", () => {
  for (const demoDir of demoServerDirs) {
    const envExamplePath = path.join(process.cwd(), demoDir, ".env.example");
    const readmePath = path.join(process.cwd(), demoDir, "README.md");
    const dockerfilePath = path.join(process.cwd(), demoDir, "Dockerfile");
    const composePath = path.join(process.cwd(), demoDir, "compose.yml");
    const composeOverridePath = path.join(process.cwd(), demoDir, "compose.override.yml.example");

    assert.equal(existsSync(envExamplePath), true, `${demoDir}: .env.example`);
    assert.equal(existsSync(readmePath), true, `${demoDir}: README.md`);
    assert.equal(existsSync(dockerfilePath), true, `${demoDir}: Dockerfile`);
    assert.equal(existsSync(composePath), true, `${demoDir}: compose.yml`);
    assert.equal(existsSync(composeOverridePath), true, `${demoDir}: compose.override.yml.example`);

    const envExample = readFileSync(envExamplePath, "utf8");
    const readme = readFileSync(readmePath, "utf8");
    const dockerfile = readFileSync(dockerfilePath, "utf8");
    const compose = readFileSync(composePath, "utf8");
    const composeOverride = readFileSync(composeOverridePath, "utf8");

    assert.match(envExample, /^OPENRECEIVE_NWC=$/m, `${demoDir}: placeholder NWC`);
    assert.doesNotMatch(envExample, /nostr\+walletconnect:\/\//);
    assert.match(readme, /The browser never receives `OPENRECEIVE_NWC`\./);
    assert.match(readme, /valid receive-only `OPENRECEIVE_NWC`/);
    assert.match(readme, /\/demo-metadata\.json/);
    assert.match(readme, /compose\.override\.yml\.example up --build/);
    assert.doesNotMatch(readme, /--profile openreceive-worker/);
    assert.match(dockerfile, /CMD \["npm", "start"\]/);
    assert.match(compose, /env_file:/);
    assert.match(compose, /path:\s+\.\.\/\.\.\/\.\.\/\.\.\/\.env/);
    assert.match(compose, /expose:/);
    assert.doesNotMatch(compose, /ports:/);
    assert.match(composeOverride, /ports:/);
    assert.doesNotMatch(dockerfile, /OPENRECEIVE_NWC=/);
    assert.doesNotMatch(compose, /nostr\+walletconnect:\/\//);
    assert.doesNotMatch(composeOverride, /nostr\+walletconnect:\/\//);
  }
});

test("Hello Fruit demos refuse to boot without OPENRECEIVE_NWC", async () => {
  await withEnv({ OPENRECEIVE_NWC: undefined }, async () => {
    for (const demo of [
      {
        name: "node-express-react-production",
        createApp: createHelloFruitProductionServer
      },
      {
        name: "static-html-small-api-production",
        createApp: createHelloFruitStaticProductionServer
      }
    ]) {
      await assert.rejects(
        () => demo.createApp(),
        /needs a receive-only NWC code to receive payments\.[\s\S]+https:\/\/openreceive\.org\/get_a_nwc_code_to_receive_payments/,
        `${demo.name}: requires NWC at boot`
      );
    }

    assert.throws(
      () => getNextDemoMetadata(),
      /needs a receive-only NWC code to receive payments\.[\s\S]+https:\/\/openreceive\.org\/get_a_nwc_code_to_receive_payments/,
      "nextjs-fullstack: metadata requires NWC"
    );
  });
});

test("Hello Fruit demos refuse malformed OPENRECEIVE_NWC before serving", async () => {
  await withEnv({ OPENRECEIVE_NWC: "https://example.com" }, async () => {
    await assert.rejects(
      () => createHelloFruitServer(),
      /OPENRECEIVE_NWC is set, but it is not a valid NWC code\.[\s\S]+NWC URI must use nostr\+walletconnect\.[\s\S]+https:\/\/openreceive\.org\/get_a_nwc_code_to_receive_payments/
    );
    await assert.rejects(
      () => createHelloFruitStaticServer(),
      /OPENRECEIVE_NWC is set, but it is not a valid NWC code\.[\s\S]+NWC URI must use nostr\+walletconnect\.[\s\S]+https:\/\/openreceive\.org\/get_a_nwc_code_to_receive_payments/
    );
    assert.throws(
      () => getNextDemoMetadata(),
      /OPENRECEIVE_NWC is set, but it is not a valid NWC code\.[\s\S]+NWC URI must use nostr\+walletconnect\.[\s\S]+https:\/\/openreceive\.org\/get_a_nwc_code_to_receive_payments/
    );
  });
});

test("Hello Fruit metadata exposes only allowlisted build fields", async () => {
  const nwc = createValidNwcUri();

  await withEnv({
    OPENRECEIVE_NWC: nwc,
    OPENRECEIVE_TEST_FAKE_NWC: "1",
    OPENRECEIVE_STORE: "memory:",
    OPENRECEIVE_DEMO_MODE: "production",
    OPENRECEIVE_GIT_SHA: "0123456789abcdef",
    OPENRECEIVE_IMAGE_DIGEST: `sha256:${"c".repeat(64)}`,
    OPENRECEIVE_DEPLOYED_AT: "2026-06-20T12:34:56Z"
  }, async () => {
    for (const demo of [
      {
        name: "node-express-react",
        createApp: createHelloFruitServer
      },
      {
        name: "static-html-small-api",
        createApp: createHelloFruitStaticServer
      }
    ]) {
      const metadata = await getJson(await demo.createApp(), "/demo-metadata.json");
      assert.equal(metadata.status, 200, `${demo.name}: metadata status`);
      assert.equal(metadata.body.mode, "production");
      assert.equal(metadata.body.build.git_sha, "0123456789abcdef");
      assert.equal(metadata.body.build.image_digest, `sha256:${"c".repeat(64)}`);
      assert.equal(metadata.body.build.deployed_at, "2026-06-20T12:34:56Z");
      assert.equal(JSON.stringify(metadata.body).includes("OPENRECEIVE_NWC"), false);
      assert.equal(JSON.stringify(metadata.body).includes("nostr+walletconnect://"), false);
      assert.equal(JSON.stringify(metadata.body).includes("secret="), false);
    }

    const nextMetadata = await responseJson(getNextDemoMetadata());
    assert.equal(nextMetadata.status, 200, "nextjs-fullstack: metadata status");
    assert.equal(nextMetadata.body.mode, "production");
    assert.equal(nextMetadata.body.build.git_sha, "0123456789abcdef");
    assert.equal(nextMetadata.body.build.image_digest, `sha256:${"c".repeat(64)}`);
    assert.equal(nextMetadata.body.build.deployed_at, "2026-06-20T12:34:56Z");
    assert.equal(JSON.stringify(nextMetadata.body).includes("OPENRECEIVE_NWC"), false);
    assert.equal(JSON.stringify(nextMetadata.body).includes("nostr+walletconnect://"), false);
    assert.equal(JSON.stringify(nextMetadata.body).includes("secret="), false);
  });
});

test("Hello Fruit demos create app orders and poll order status through merchant routes", async () => {
  await withEnv({
    OPENRECEIVE_NWC: createValidNwcUri(),
    OPENRECEIVE_TEST_FAKE_NWC: "1",
    OPENRECEIVE_STORE: "memory:"
  }, async () => {
    const orderRequest = {
      idempotency_key: "cart-smoke",
      cart: [
        { product_id: "banana", quantity: 2 },
        { product_id: "apple", quantity: 1 }
      ]
    };

    for (const demo of [
      {
        name: "node-express-react",
        createApp: createHelloFruitServer
      },
      {
        name: "static-html-small-api",
        createApp: createHelloFruitStaticServer
      }
    ]) {
      const app = await demo.createApp();
      const created = await dispatchJson(app, "POST", "/create_order", orderRequest);
      assert.equal(created.status, 201, `${demo.name}: create_order status`);
      assert.equal(created.body.order.uuid.includes("cart-smoke"), true);
      assert.equal(created.body.order.status, "pending_payment");
      assert.equal(created.body.order.total_fiat.currency, "USD");
      assert.equal(created.body.order.total_fiat.value, "0.25");
      assert.equal(created.body.invoice.order_uuid, created.body.order.uuid);
      assert.equal(typeof created.body.invoice.invoice, "string");
      assert.equal(JSON.stringify(created.body).includes("nostr+walletconnect://"), false);

      const replayed = await dispatchJson(app, "POST", "/create_order", orderRequest);
      assert.equal(replayed.body.invoice.invoice_id, created.body.invoice.invoice_id,
        `${demo.name}: create_order is idempotent for the same checkout id and cart`);

      const status = await dispatchJson(app, "POST", "/order_status", {
        payment_hash: created.body.invoice.payment_hash
      });
      assert.equal(status.status, 200, `${demo.name}: order_status status`);
      assert.equal(status.body.order_uuid, created.body.order.uuid);
      assert.equal(status.body.order_status, "pending_payment");
      assert.equal(status.body.order.status, "pending_payment");
      assert.equal(status.body.payment_hash, created.body.invoice.payment_hash);
    }

    const nextCreated = await responseJson(postNextCreateOrder(jsonRequest("/create_order", orderRequest)));
    assert.equal(nextCreated.status, 201, "nextjs-fullstack: create_order status");
    assert.equal(nextCreated.body.order.uuid.includes("cart-smoke"), true);
    assert.equal(nextCreated.body.order.total_fiat.value, "0.25");
    assert.equal(nextCreated.body.invoice.order_uuid, nextCreated.body.order.uuid);

    const nextReplayed = await responseJson(postNextCreateOrder(jsonRequest("/create_order", orderRequest)));
    assert.equal(nextReplayed.body.invoice.invoice_id, nextCreated.body.invoice.invoice_id,
      "nextjs-fullstack: create_order is idempotent for the same checkout id and cart");

    const nextStatus = await responseJson(postNextOrderStatus(jsonRequest("/order_status", {
      payment_hash: nextCreated.body.invoice.payment_hash
    })));
    assert.equal(nextStatus.status, 200, "nextjs-fullstack: order_status status");
    assert.equal(nextStatus.body.order_uuid, nextCreated.body.order.uuid);
    assert.equal(nextStatus.body.order_status, "pending_payment");
  });
});

test("Hello Fruit hosted demo routes expose source, docs, robots, and sitemap", async () => {
  await withEnv({
    OPENRECEIVE_NWC: createValidNwcUri(),
    OPENRECEIVE_TEST_FAKE_NWC: "1",
    OPENRECEIVE_PUBLIC_URL: "https://demo.example.test",
    OPENRECEIVE_DEMO_NOINDEX: undefined
  }, async () => {
    for (const demo of [
      {
        name: "node-express-react",
        sourcePath: "examples/hello-fruit/server/node-express-react",
        createApp: createHelloFruitServer
      },
      {
        name: "static-html-small-api",
        sourcePath: "examples/hello-fruit/server/static-html-small-api",
        createApp: createHelloFruitStaticServer
      }
    ]) {
      const app = await demo.createApp();
      const source = await dispatch(app, {
        method: "GET",
        url: "/source",
        headers: {}
      });
      assert.equal(source.status, 302, `${demo.name}: source status`);
      assert.equal(
        source.headers.get("location"),
        `https://github.com/openreceive/openreceive/tree/main/${demo.sourcePath}`
      );

      const docs = await dispatch(app, {
        method: "GET",
        url: "/docs",
        headers: {}
      });
      assert.equal(docs.status, 302, `${demo.name}: docs status`);
      assert.equal(
        docs.headers.get("location"),
        "https://github.com/openreceive/openreceive/blob/main/docs/guides/quickstart-node.md"
      );

      const robots = await dispatch(app, {
        method: "GET",
        url: "/robots.txt",
        headers: {}
      });
      assert.equal(robots.status, 200, `${demo.name}: robots status`);
      assert.match(robots.text, /Allow: \//);
      assert.match(robots.text, /Sitemap: https:\/\/demo\.example\.test\/sitemap\.xml/);

      const sitemap = await dispatch(app, {
        method: "GET",
        url: "/sitemap.xml",
        headers: {}
      });
      assert.equal(sitemap.status, 200, `${demo.name}: sitemap status`);
      assert.match(sitemap.text, /<loc>https:\/\/demo\.example\.test\/<\/loc>/);

      for (const response of [source.text, docs.text, robots.text, sitemap.text]) {
        assert.equal(JSON.stringify(response).includes("OPENRECEIVE_NWC"), false);
        assert.equal(JSON.stringify(response).includes("nostr+walletconnect://"), false);
      }
    }

    const nextSource = getNextSource();
    assert.equal(nextSource.status, 302, "nextjs-fullstack: source status");
    assert.equal(
      nextSource.headers.get("location"),
      "https://github.com/openreceive/openreceive/tree/main/examples/hello-fruit/server/nextjs-fullstack"
    );

    const nextDocs = getNextDocs();
    assert.equal(nextDocs.status, 302, "nextjs-fullstack: docs status");
    assert.equal(
      nextDocs.headers.get("location"),
      "https://github.com/openreceive/openreceive/blob/main/docs/guides/frontend-checkout.md"
    );

    assert.equal(nextRobotsDynamic, "force-dynamic");
    const nextRobots = getNextRobots();
    assert.deepEqual(nextRobots.rules, {
      userAgent: "*",
      allow: "/"
    });
    assert.equal(nextRobots.sitemap, "https://demo.example.test/sitemap.xml");

    assert.equal(nextSitemapDynamic, "force-dynamic");
    const nextSitemap = getNextSitemap();
    assert.equal(nextSitemap[0]?.url, "https://demo.example.test");
    assert.equal(JSON.stringify(nextRobots).includes("OPENRECEIVE_NWC"), false);
    assert.equal(JSON.stringify(nextSitemap).includes("nostr+walletconnect://"), false);
  });
});

async function responseJson(responseOrPromise) {
  const response = await responseOrPromise;
  return {
    status: response.status,
    body: await response.json()
  };
}

function jsonRequest(pathname, body) {
  return new Request(`http://localhost${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

async function getJson(app, url) {
  return await dispatchJson(app, "GET", url);
}

async function dispatchJson(app, method, url, body) {
  const response = await dispatch(app, {
    method,
    url,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(body === undefined ? {} : { "idempotency-key": "demo-smoke" })
    },
    body
  });

  return {
    status: response.status,
    body: JSON.parse(response.text)
  };
}

async function dispatch(app, options) {
  return await new Promise((resolve, reject) => {
    const payload =
      options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
    const req = new Readable({
      read() {
        if (payload !== undefined) this.push(payload);
        this.push(null);
      }
    });
    req.method = options.method;
    req.url = options.url;
    req.headers = {
      ...options.headers,
      ...(payload === undefined ? {} : { "content-length": String(payload.length) })
    };
    req.encrypted = false;
    req.connection = req;
    req.socket = req;
    req.on("error", reject);

    const chunks = [];
    const headers = new Map();
    const res = {
      statusCode: 200,
      headersSent: false,
      locals: {},
      app,
      req,
      setHeader(name, value) {
        headers.set(name.toLowerCase(), value);
      },
      getHeader(name) {
        return headers.get(name.toLowerCase());
      },
      removeHeader(name) {
        headers.delete(name.toLowerCase());
      },
      writeHead(statusCode, _reason, headerValues) {
        this.statusCode = statusCode;
        if (headerValues !== undefined) {
          for (const [name, value] of Object.entries(headerValues)) {
            this.setHeader(name, value);
          }
        }
        this.headersSent = true;
        return this;
      },
      write(chunk) {
        if (chunk !== undefined) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }
        return true;
      },
      end(chunk) {
        if (chunk !== undefined) this.write(chunk);
        this.headersSent = true;
        resolve({
          status: this.statusCode,
          text: Buffer.concat(chunks).toString("utf8"),
          headers
        });
      },
      on() {
        return this;
      },
      once() {
        return this;
      },
      emit() {
        return false;
      }
    };

    app.handle(req, res, reject);
  });
}

async function withEnv(env, callback) {
  const previous = new Map();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
