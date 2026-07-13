import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

const REACT_SRC_DIR = path.join(process.cwd(), "packages/js/react/src");
// The react package source is split across logical modules; read them all so
// structure assertions stay location-agnostic across future refactors.
function readReactSource() {
  return readdirSync(REACT_SRC_DIR)
    .filter((file) => file.endsWith(".ts"))
    .sort()
    .map((file) => readFileSync(path.join(REACT_SRC_DIR, file), "utf8"))
    .join("\n");
}
import { createHelloFruitServer } from "../../examples/hello-fruit/server/node-express/src/server/create-server.ts";
import { createHelloFruitProductionServer } from "../../examples/hello-fruit/server/node-express/src/server/production.ts";
import { createHelloFruitStaticServer } from "../../examples/hello-fruit/server/static-html-small-api/src/server/create-server.ts";
import { createHelloFruitStaticProductionServer } from "../../examples/hello-fruit/server/static-html-small-api/src/server/production.ts";
import {
  createHelloFruitInvoiceDescription,
  formatHelloFruitBuyNowLabel,
  formatHelloFruitFiat,
  helloFruitDemoLabels,
} from "../../examples/hello-fruit/shared/demo-formatting.ts";
import {
  createHelloFruitDemoServerLogger,
  createHelloFruitOpenReceiveLogger,
} from "../../examples/hello-fruit/shared/demo-logging.ts";
import {
  convertHelloFruitUsdAmount,
  toHelloFruitDisplayAmount,
} from "../../examples/hello-fruit/shared/demo-pricing.ts";
import { readHelloFruitCheckoutCurrencies } from "../../examples/hello-fruit/shared/demo-currencies.ts";
import { InMemoryInvoiceKvStore, StaticPriceProvider } from "../../packages/js/core/src/index.ts";
import { setHelloFruitOpenReceiveTestOverrides } from "../../examples/hello-fruit/server/nextjs-fullstack/src/server/openreceive.ts";
import { GET as getNextDemoMetadata } from "../../examples/hello-fruit/server/nextjs-fullstack/src/app/demo-metadata.json/route.ts";
import { GET as getNextDocs } from "../../examples/hello-fruit/server/nextjs-fullstack/src/app/docs/route.ts";
import { GET as getNextOpenReceive, POST as postNextOpenReceive } from "../../examples/hello-fruit/server/nextjs-fullstack/src/app/openreceive/[...openreceive]/route.ts";
import { GET as getNextSource } from "../../examples/hello-fruit/server/nextjs-fullstack/src/app/source/route.ts";
import getNextRobots, {
  dynamic as nextRobotsDynamic,
} from "../../examples/hello-fruit/server/nextjs-fullstack/src/app/robots.ts";
import getNextSitemap, {
  dynamic as nextSitemapDynamic,
} from "../../examples/hello-fruit/server/nextjs-fullstack/src/app/sitemap.ts";

const productPath = path.join(process.cwd(), "examples/hello-fruit/shared/product.json");
const fruitsPath = path.join(process.cwd(), "examples/hello-fruit/shared/fruits.json");
const canonicalDemoDataPath = path.join(process.cwd(), "spec/data/demo/fruits.json");
const demoServerDirs = [
  "examples/hello-fruit/server/node-express",
  "examples/hello-fruit/server/static-html-small-api",
  "examples/hello-fruit/server/nextjs-fullstack",
];


class HelloFruitTestReceiveClient {
  count = 0;
  // Track every invoice we mint so status polling can reconcile a real wallet payment and
  // `settleAll()` can move money in the fake wallet (the settle-via-fake-wallet step the mounted
  // order route needs to report a paid order).
  invoices = [];

  async preflight() {
    return {
      walletPubkey: "f".repeat(64),
      relays: ["wss://relay.example.com"],
      methods: ["make_invoice", "list_transactions"],
      encryption: "nip44_v2",
      spendCapabilityAdvertised: false,
      receiveCheckoutReady: true,
      warnings: [],
    };
  }

  async makeInvoice(request) {
    this.count += 1;
    const paymentHash = this.count.toString(16).padStart(64, "0");
    const createdAt = Math.floor(Date.now() / 1000);
    const invoice = {
      invoice: `lnbc-hello-fruit-test-${this.count}`,
      payment_hash: paymentHash,
      amount_msats: request.amount_msats,
      created_at: createdAt,
      expires_at: createdAt + 600,
      transaction_state: "pending",
      settled_at: undefined,
    };
    this.invoices.push(invoice);
    return {
      invoice: invoice.invoice,
      payment_hash: invoice.payment_hash,
      amount_msats: invoice.amount_msats,
      created_at: invoice.created_at,
      expires_at: invoice.expires_at,
    };
  }

  async listTransactions(request) {
    if (request.type === "outgoing") return { transactions: [] };
    const from = request.from ?? 0;
    const until = request.until ?? Number.MAX_SAFE_INTEGER;
    return {
      transactions: this.invoices
        .filter((invoice) => invoice.created_at >= from && invoice.created_at <= until)
        .map((invoice) => ({
          type: "incoming",
          invoice: invoice.invoice,
          payment_hash: invoice.payment_hash,
          amount_msats: invoice.amount_msats,
          transaction_state: invoice.transaction_state,
          created_at: invoice.created_at,
          settled_at: invoice.transaction_state === "settled" ? invoice.settled_at : undefined,
          preimage: invoice.transaction_state === "settled" ? "1".repeat(64) : undefined,
        })),
    };
  }

  /** Settle every minted invoice, so the next order-status reconcile reports the order paid. */
  settleAll(settledAt = Math.floor(Date.now() / 1000)) {
    for (const invoice of this.invoices) {
      invoice.transaction_state = "settled";
      invoice.settled_at = settledAt;
    }
  }
}

function createHelloFruitTestOpenReceiveOptions() {
  return {
    client: new HelloFruitTestReceiveClient(),
    store: new InMemoryInvoiceKvStore(),
    priceProviders: [new StaticPriceProvider()],
    configPath: false,
  };
}

// Creating a checkout runs an initial wallet verify that claims the shared transaction-scan gate
// (a ~2s throttle between full wallet scans). Reset it in the store so the very next order-status
// poll performs a real scan and observes the fake-wallet settlement deterministically, rather than
// the test having to sleep out the throttle.
async function resetTransactionScanGate(store) {
  const current = await store.getMeta("transaction_scan_gate");
  await store.casMeta(
    "transaction_scan_gate",
    JSON.stringify({ claimed_at: 0 }),
    current?.rev ?? null,
  );
}

test("Hello Fruit shared product metadata stays stable", () => {
  const product = JSON.parse(readFileSync(productPath, "utf8"));

  assert.equal(product.schema_version, "0.1.0");
  assert.equal(product.name, "OpenReceive Demo: Buy A Fruit Sticker");
  assert.equal(product.description, "get a fruit sticker");
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
    canonical.fruits,
  );

  for (const fruit of fruits.fruits) {
    assert.equal(fruit.sticker, `stickers/${fruit.id}.svg`);
    assert.equal(
      existsSync(path.join(process.cwd(), "examples/hello-fruit/shared", fruit.sticker)),
      true,
      `${fruit.id}: sticker exists`,
    );
  }
});

test("Hello Fruit demos share product display formatting", () => {
  assert.equal(formatHelloFruitFiat({ currency: "USD", value: "0.10" }), "$0.10");
  assert.equal(formatHelloFruitFiat({ currency: "EUR", value: "0.10" }), "0.10 EUR");
  assert.equal(
    formatHelloFruitBuyNowLabel({ currency: "USD", value: "0.10" }),
    "Add to cart ($0.10)",
  );
  assert.equal(
    formatHelloFruitBuyNowLabel({ currency: "EUR", value: "0.10" }),
    "Add to cart (0.10 EUR)",
  );
  assert.equal(helloFruitDemoLabels.createOrder, "Create order");
  assert.equal(helloFruitDemoLabels.creatingOrder, "Creating order...");
  assert.equal(helloFruitDemoLabels.createOrderError, "Could not create order.");
  assert.equal(
    createHelloFruitInvoiceDescription("Banana"),
    "Fruit sticker from OpenReceive demo: Banana",
  );
  assert.equal(
    createHelloFruitInvoiceDescription("Banana", { demoName: "Next.js" }),
    "Fruit sticker from OpenReceive Next.js demo: Banana",
  );
});

test("Hello Fruit server loggers omit undefined fields and debug console noise", () => {
  const calls = [];
  const originalLog = console.log;
  const originalInfo = console.info;
  console.log = (...args) => calls.push(args);
  console.info = (...args) => calls.push(args);

  try {
    createHelloFruitDemoServerLogger("node-express")(
      "order_status.response",
      "Refreshed order status.",
      {
        orderId: "order-1",
        transactionState: undefined,
        state: undefined,
        nested: {
          kept: true,
          missing: undefined,
        },
      },
    );
    createHelloFruitOpenReceiveLogger("node-express")({
      level: "debug",
      event: "order.status.requested",
      message: "Refreshing order status.",
      order_id: "order-1",
    });
    createHelloFruitOpenReceiveLogger("node-express")({
      level: "info",
      event: "order.status.result",
      message: "Order status refresh completed.",
      order_id: "order-1",
      reason: undefined,
      wallet_scan_performed: true,
    });
  } finally {
    console.log = originalLog;
    console.info = originalInfo;
  }

  assert.equal(calls.length, 2);
  assert.equal(typeof calls[0][1].at, "string");
  assert.deepEqual(calls[0][1], {
    at: calls[0][1].at,
    orderId: "order-1",
    nested: {
      kept: true,
    },
  });
  assert.deepEqual(calls[1][1], {
    order_id: "order-1",
    wallet_scan_performed: true,
  });
});

test("Hello Fruit display conversion handles integer (scale-0) BTC rates", () => {
  // Large-denomination currencies (VND, IDR, KRW, ...) come back from the live
  // feed as plain integers like "2500000000" (no fractional digits). The scale
  // of such a rate is 0, which previously zeroed the conversion denominator and
  // threw "Division by zero". Guard against that regression here.
  const usdAmount = { currency: "USD", value: "1.50" };
  const rates = {
    bitcoin: {
      usd: "50000.00",
      vnd: "2500000000",
      eur: "46000.50",
    },
  };

  assert.deepEqual(convertHelloFruitUsdAmount(usdAmount, "VND", rates), {
    currency: "VND",
    value: "75000.00",
  });
  // An integer USD/BTC base rate (scale 0) must convert too.
  assert.deepEqual(
    convertHelloFruitUsdAmount(usdAmount, "VND", {
      bitcoin: { usd: "50000", vnd: "2500000000" },
    }),
    { currency: "VND", value: "75000.00" },
  );
  // Direct Bitcoin units exercise the usdToSats path with an integer base rate.
  assert.deepEqual(
    convertHelloFruitUsdAmount(usdAmount, "SATS", {
      bitcoin: { usd: "50000" },
    }),
    { currency: "SATS", value: "3000" },
  );
  // Decimal target rates keep converting correctly.
  assert.deepEqual(convertHelloFruitUsdAmount(usdAmount, "EUR", rates), {
    currency: "EUR",
    value: "1.39",
  });
  // The display wrapper must never throw for a supported currency.
  assert.deepEqual(toHelloFruitDisplayAmount(usdAmount, "VND", rates), {
    currency: "VND",
    value: "75000.00",
  });
});

test("Hello Fruit demos share transaction details helper on success UI", () => {
  const helper = readFileSync(
    path.join(process.cwd(), "examples/hello-fruit/shared/demo-transaction-details.ts"),
    "utf8",
  );
  assert.match(helper, /createOpenReceiveTransactionDetails/);
  assert.match(helper, /createOpenReceiveTransactionDetailsFromState/);
  assert.match(helper, /@openreceive\/elements/);
  assert.match(helper, /createTransactionDetailsElement/);
  assert.doesNotMatch(helper, /nwc/i);
  assert.doesNotMatch(helper, /nostr\+walletconnect/i);

  const reactSources = [
    "examples/hello-fruit/server/node-express/src/client/App.tsx",
    "examples/hello-fruit/server/nextjs-fullstack/src/app/checkout-client.tsx",
  ];
  for (const relativePath of reactSources) {
    const source = readFileSync(path.join(process.cwd(), relativePath), "utf8");
    assert.match(source, /TransactionDetails/, `${relativePath}: uses package TransactionDetails`);
    assert.match(source, /\bresume\b/, `${relativePath}: uses Checkout resume`);
    assert.match(source, /onSummary/, `${relativePath}: handles summary redraw`);
    assert.doesNotMatch(source, /nwc/i, `${relativePath}: must not expose NWC in browser UI`);
  }

  const vanilla = readFileSync(
    path.join(process.cwd(), "examples/hello-fruit/server/static-html-small-api/src/client/main.ts"),
    "utf8",
  );
  assert.match(vanilla, /createTransactionDetailsElement/);
  assert.match(vanilla, /OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES\.resume/);
  assert.match(vanilla, /openreceive-summary|OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS\.summary/);
  assert.doesNotMatch(vanilla, /nwc/i);
});

test("Hello Fruit React demos delegate checkout state to UI packages", () => {
  const nodeClient = readFileSync(
    path.join(process.cwd(), "examples/hello-fruit/server/node-express/src/client/App.tsx"),
    "utf8",
  );
  const nextClient = readFileSync(
    path.join(
      process.cwd(),
      "examples/hello-fruit/server/nextjs-fullstack/src/app/checkout-client.tsx",
    ),
    "utf8",
  );

  for (const [, source] of [
    ["node-express", nodeClient],
    ["nextjs-fullstack", nextClient],
  ]) {
    assert.match(source, /<Checkout/);
    assert.match(source, /onSettled=/);
    // Self-contained component: it receives an order id and derives its own routes; the app never
    // hand-writes an /order (invoice/status/swap) handler or passes an orderUrl.
    assert.match(source, /orderId=\{\(order\?\.uuid \?\? resumeOrderId\) as string\}/);
    assert.doesNotMatch(source, /orderUrl="\/order"/);
    assert.match(source, /fetch\("\/openreceive\/prepare"/);
    assert.doesNotMatch(source, /fetch\("\/create_order"/);
    assert.match(source, /readHelloFruitCheckoutCurrencies/);
    assert.match(source, /currency,/);
    assert.doesNotMatch(source, /createOpenReceiveStatusFetcher/);
    assert.doesNotMatch(source, /statusUrl="\/openreceive\/v1\/invoices\/\{invoice_id\}\/status"/);
    assert.doesNotMatch(source, /refreshStatus=\{refreshStatus\}/);
    assert.doesNotMatch(source, /fetch\("\/openreceive\/v1\/invoices\/.*\/status"/);
    assert.doesNotMatch(source, /fetch\("\/openreceive\/v1\/invoices"/);
    assert.doesNotMatch(source, /payment_hash: state\.payment_hash/);
    assert.doesNotMatch(source, /new EventSource/);
    assert.doesNotMatch(source, /applyOpenReceiveInvoiceEvent/);
    assert.doesNotMatch(source, /parseOpenReceiveInvoiceEvent/);
    assert.doesNotMatch(source, /createCheckoutState/);
  }

  assert.match(nodeClient, /@openreceive\/vue\/checkout\.vue/);
  assert.match(nodeClient, /@openreceive\/svelte\/checkout\.svelte/);
  assert.match(nodeClient, /@openreceive\/angular\/checkout-component/);
  assert.match(nodeClient, /checkoutFrameworks/);
  assert.match(nodeClient, /React/);
  assert.match(nodeClient, /Vue/);
  assert.match(nodeClient, /Svelte/);
  assert.match(nodeClient, /Angular/);
});

test("Hello Fruit demos expose price-feed currencies plus direct Bitcoin units", () => {
  const currencies = readHelloFruitCheckoutCurrencies();
  for (const currency of ["USD", "EUR", "JPY", "BTC", "SATS"]) {
    assert.equal(currencies.includes(currency), true, currency);
  }

  const staticClient = readFileSync(
    path.join(
      process.cwd(),
      "examples/hello-fruit/server/static-html-small-api/src/client/main.ts",
    ),
    "utf8",
  );
  assert.match(staticClient, /readHelloFruitCheckoutCurrencies/);
  assert.match(staticClient, /selectedCurrency/);
  assert.match(staticClient, /currency: selectedCurrency/);
});

test("Hello Fruit JS demos use package-owned QR and status refresh wiring", () => {
  const clientSources = [
    "examples/hello-fruit/server/node-express/src/client/App.tsx",
    "examples/hello-fruit/server/static-html-small-api/src/client/main.ts",
    "examples/hello-fruit/server/nextjs-fullstack/src/app/checkout-client.tsx",
  ];

  for (const sourcePath of clientSources) {
    const source = readFileSync(path.join(process.cwd(), sourcePath), "utf8");
    assert.doesNotMatch(
      source,
      /from "qrcode"/,
      `${sourcePath}: QR encoder must come from the UI package`,
    );
    assert.doesNotMatch(
      source,
      /qrEncoder/,
      `${sourcePath}: demo must not pass a local QR encoder`,
    );
  }

  assert.equal(
    existsSync(
      path.join(process.cwd(), "examples/hello-fruit/server/nextjs-fullstack/src/qrcode.d.ts"),
    ),
    false,
  );

  for (const demoDir of demoServerDirs) {
    const packageJson = JSON.parse(
      readFileSync(path.join(process.cwd(), demoDir, "package.json"), "utf8"),
    );
    const viteConfigPath = path.join(process.cwd(), demoDir, "vite.config.ts");
    const viteConfig = existsSync(viteConfigPath) ? readFileSync(viteConfigPath, "utf8") : "";
    const compose = readFileSync(path.join(process.cwd(), demoDir, "compose.yml"), "utf8");
    const dockerfile = readFileSync(path.join(process.cwd(), demoDir, "Dockerfile"), "utf8");
    const configPath = path.join(process.cwd(), demoDir, "openreceive.config.mjs");

    assert.equal(packageJson.dependencies.qrcode, undefined, `${demoDir}: qrcode is package-owned`);
    assert.match(
      dockerfile,
      /COPY spec\/data\/rates \.\/spec\/data\/rates/,
      `${demoDir}: Docker image includes demo price-source data`,
    );
    if (demoDir.endsWith("/node-express")) {
      const openReceiveVersion = JSON.parse(
        readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
      ).version;
      assert.equal(packageJson.dependencies["@openreceive/angular"], openReceiveVersion);
      assert.equal(packageJson.dependencies["@openreceive/vue"], openReceiveVersion);
      assert.equal(packageJson.dependencies["@openreceive/svelte"], openReceiveVersion);
      assert.equal(packageJson.dependencies["@angular/core"], "^22.0.3");
      assert.equal(packageJson.dependencies["@angular/platform-browser"], "^22.0.3");
      assert.match(viteConfig, /@vitejs\/plugin-vue/);
      assert.match(viteConfig, /vue\/compiler-sfc/);
      assert.match(viteConfig, /vue\(\{\s*compiler:\s*vueCompiler\s*\}\)/);
      assert.match(viteConfig, /@sveltejs\/vite-plugin-svelte/);
    }
    assert.match(packageJson.scripts.dev, /require-openreceive-nwc\.ts/);
    assert.match(packageJson.scripts.start, /require-openreceive-nwc\.ts/);
    assert.equal(packageJson.scripts["openreceive:worker"], undefined);
    assert.equal(packageJson.scripts["openreceive:poll"], undefined);
    assert.equal(existsSync(configPath), false, `${demoDir}: openreceive.yml replaces wrapper config`);
    assert.doesNotMatch(compose, /openreceive-worker/);
    assert.doesNotMatch(compose, /command:\s+\["npm", "run", "openreceive:worker"\]/);
  }
});

test("Hello Fruit Node demo creates orders from cart before rendering checkout", () => {
  const source = readFileSync(
    path.join(process.cwd(), "examples/hello-fruit/server/node-express/src/client/App.tsx"),
    "utf8",
  );

  assert.match(source, /function startOver\(\)/);
  assert.match(source, /addSelectedFruitToCart/);
  assert.match(source, /async function createOrder\(\)/);
  assert.match(source, /fetch\("\/openreceive\/prepare"/);
  assert.doesNotMatch(source, /fetch\("\/create_order"/);
  // The self-contained component receives the order id; no hand-written order URL.
  assert.match(source, /orderId=\{\(order\?\.uuid \?\? resumeOrderId\) as string\}/);
  assert.doesNotMatch(source, /orderUrl="\/order"/);
  assert.match(source, /setPurchasedItems\((?:order|summary)\.items\)/);
  assert.match(source, /formatHelloFruitFiat\(item\.line_amount\)/);
  assert.match(source, /purchasedItems\.map/);
  assert.match(source, /setCart\(\{\}\)/);
  assert.match(source, /setOrder\(null\)/);
  assert.doesNotMatch(source, /setCheckout\(null\)/);
  assert.match(source, /setPurchasedItems\(\[\]\)/);
  assert.match(source, /setFruitId\(initialFruitId\)/);
  assert.match(source, /order === null/);
  assert.match(source, /onStartOver=\{startOver\}/);
  assert.match(source, />\s*Start over\s*</);
  assert.doesNotMatch(source, /crypto\?\.randomUUID/);
  assert.doesNotMatch(source, /idempotency_key/);
  assert.doesNotMatch(source, /purchasedFruit/);
});

test("Hello Fruit Next.js demo resets expired checkout from Start over", () => {
  const source = readFileSync(
    path.join(
      process.cwd(),
      "examples/hello-fruit/server/nextjs-fullstack/src/app/checkout-client.tsx",
    ),
    "utf8",
  );

  assert.match(source, /function startOver\(\)/);
  assert.match(source, /async function createOrder\(\)/);
  assert.match(source, /fetch\("\/openreceive\/prepare"/);
  assert.doesNotMatch(source, /fetch\("\/create_order"/);
  assert.match(source, /orderId=\{\(order\?\.uuid \?\? resumeOrderId\) as string\}/);
  assert.doesNotMatch(source, /orderUrl="\/order"/);
  assert.match(source, /setCart\(\{\}\)/);
  assert.match(source, /setOrder\(undefined\)/);
  assert.doesNotMatch(source, /setCheckout\(undefined\)/);
  assert.match(source, /setStatus\("idle"\)/);
  assert.match(source, /onStartOver=\{startOver\}/);
  assert.match(source, /helloFruitCheckoutPath/);
  assert.match(source, /rememberHelloFruitOrder/);
  assert.match(source, /\bresume\b/);
  assert.match(source, /onSummary/);
  assert.match(source, /resumeOrderId/);
});

test("Hello Fruit demos resume guest checkout from /checkout/:orderId", () => {
  const resumeHelper = readFileSync(
    path.join(process.cwd(), "examples/hello-fruit/shared/demo-checkout-resume.ts"),
    "utf8",
  );
  assert.match(resumeHelper, /HELLO_FRUIT_CHECKOUT_PATH_PREFIX = "\/checkout"/);
  assert.match(resumeHelper, /parseHelloFruitCheckoutOrderId/);
  assert.match(resumeHelper, /rememberHelloFruitOrder/);
  assert.match(resumeHelper, /enterCheckoutResumePath|enterHelloFruitCheckout/);
  assert.doesNotMatch(resumeHelper, /order_access_token/);

  for (const [relativePath, patterns] of [
    [
      "examples/hello-fruit/server/node-express/src/client/App.tsx",
      [/\bresume\b/, /onSummary/, /enterHelloFruitCheckout/, /parseHelloFruitCheckoutOrderId/],
    ],
    [
      "examples/hello-fruit/server/nextjs-fullstack/src/app/checkout-client.tsx",
      [/helloFruitCheckoutPath/, /\bresume\b/, /onSummary/, /resumeOrderId/],
    ],
    [
      "examples/hello-fruit/server/static-html-small-api/src/client/main.ts",
      [/enterHelloFruitCheckout/, /resumeCheckoutFromUrl/, /requestOrderSummary/],
    ],
  ]) {
    const source = readFileSync(path.join(process.cwd(), relativePath), "utf8");
    for (const pattern of patterns) {
      assert.match(source, pattern, `${relativePath}: ${pattern}`);
    }
  }

  assert.equal(
    existsSync(
      path.join(
        process.cwd(),
        "examples/hello-fruit/server/nextjs-fullstack/src/app/checkout/[orderId]/page.tsx",
      ),
    ),
    true,
  );
  assert.equal(
    existsSync(
      path.join(
        process.cwd(),
        "examples/hello-fruit/server/nextjs-fullstack/src/app/orders/[orderId]/route.ts",
      ),
    ),
    false,
  );

  for (const sourcePath of [
    "examples/hello-fruit/server/node-express/src/server/create-server.ts",
    "examples/hello-fruit/server/static-html-small-api/src/server/create-server.ts",
    "examples/hello-fruit/server/nextjs-fullstack/src/server/openreceive.ts",
  ]) {
    const source = readFileSync(path.join(process.cwd(), sourcePath), "utf8");
    assert.match(source, /prepareCheckout/, `${sourcePath}: prepareCheckout mount`);
    assert.match(source, /createHelloFruitPrepareCheckout/, `${sourcePath}: shared prepare hook`);
  }
});

test("Hello Fruit browser demos consume shared product display helpers", () => {
  const sources = [
    "examples/hello-fruit/server/node-express/src/client/App.tsx",
    "examples/hello-fruit/server/nextjs-fullstack/src/app/checkout-client.tsx",
    "examples/hello-fruit/server/static-html-small-api/src/client/main.ts",
  ].map((relativePath) => [
    relativePath,
    readFileSync(path.join(process.cwd(), relativePath), "utf8"),
  ]);

  for (const [relativePath, source] of sources) {
    assert.match(
      source,
      /formatHelloFruitFiat/,
      `${relativePath}: uses shared fiat display helper`,
    );
    assert.match(
      source,
      /formatHelloFruitBuyNowLabel/,
      `${relativePath}: uses shared buy-now label helper`,
    );
    assert.match(
      source,
      /helloFruitDemoLabels/,
      `${relativePath}: uses shared demo checkout labels`,
    );
    assert.doesNotMatch(
      source,
      /function formatFiat/,
      `${relativePath}: must not duplicate fiat display formatting`,
    );
    assert.doesNotMatch(
      source,
      /Fruit sticker from OpenReceive .*demo: \$\{/,
      `${relativePath}: must not duplicate invoice description templates`,
    );
    assert.doesNotMatch(
      source,
      /"Could not create order\."/,
      `${relativePath}: must not duplicate order error fallback`,
    );
    assert.doesNotMatch(
      source,
      /"Creating order\.\.\."/,
      `${relativePath}: must not duplicate order creation label`,
    );
  }
});

test("Hello Fruit static demo delegates checkout state to the web component", () => {
  const source = readFileSync(
    path.join(
      process.cwd(),
      "examples/hello-fruit/server/static-html-small-api/src/client/main.ts",
    ),
    "utf8",
  );
  const html = readFileSync(
    path.join(process.cwd(), "examples/hello-fruit/server/static-html-small-api/index.html"),
    "utf8",
  );

  assert.match(source, /defineOpenReceiveElements/);
  // Self-contained: render the <openreceive-checkout> element with just an order id (prefix
  // defaults to /openreceive); it creates the checkout, polls, and drives swaps itself. The app
  // fetches /openreceive/prepare (build + persist the order) and writes no invoice/status/swap routes.
  assert.match(source, /fetch\("\/openreceive\/prepare"/);
  assert.doesNotMatch(source, /fetch\("\/create_order"/);
  assert.match(source, /OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME/);
  assert.match(source, /OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES\.orderId|setAttribute\("order-id"/);
  assert.match(source, /OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES\.resume/);
  assert.doesNotMatch(source, /createCheckoutShell/);
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
    path.join(process.cwd(), "examples/hello-fruit/server/node-express/src/client/App.tsx"),
    "utf8",
  );
  const nextClient = readFileSync(
    path.join(
      process.cwd(),
      "examples/hello-fruit/server/nextjs-fullstack/src/app/checkout-client.tsx",
    ),
    "utf8",
  );
  const staticClient = readFileSync(
    path.join(
      process.cwd(),
      "examples/hello-fruit/server/static-html-small-api/src/client/main.ts",
    ),
    "utf8",
  );

  for (const [name, source] of [
    ["node-express", nodeClient],
    ["nextjs-fullstack", nextClient],
  ]) {
    assert.match(source, /ThemeScope/, `${name}: uses package theme scope`);
    assert.match(source, /themeToggle/, `${name}: enables package theme toggle`);
    assert.match(source, /topbarClassName="topbar[\s"]/, `${name}: styles package theme toggle shell`);
    assert.doesNotMatch(source, /useOpenReceiveTheme/, `${name}: must not wire theme hook locally`);
    assert.doesNotMatch(
      source,
      /OpenReceiveThemeToggle/,
      `${name}: must not wire theme button locally`,
    );
    assert.doesNotMatch(
      source,
      /\.\.\.theme\.attributes/,
      `${name}: must not apply theme attrs locally`,
    );
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
  const reactSource = readReactSource();
  const elementsSource = readFileSync(
    path.join(process.cwd(), "packages/js/elements/src/index.ts"),
    "utf8",
  );

  for (const [name, source] of [
    ["react", reactSource],
    ["elements", elementsSource],
  ]) {
    assert.match(source, /createCheckoutController/, `${name}: uses browser checkout controller`);
    assert.match(
      source,
      /createCheckoutStatusModel/,
      `${name}: uses browser checkout status display model`,
    );
    assert.doesNotMatch(
      source,
      /new CheckoutWatcher/,
      `${name}: must not construct checkout watcher locally`,
    );
    assert.doesNotMatch(
      source,
      /createOpenReceiveStatusFetcher/,
      `${name}: must not construct status fetcher locally`,
    );
    assert.doesNotMatch(source, /new EventSource/, `${name}: must not own SSE wiring`);
    assert.doesNotMatch(
      source,
      /setInterval\(/,
      `${name}: must not own polling or countdown intervals`,
    );
    assert.doesNotMatch(source, /fetch\(statusUrl/, `${name}: must not own status POST wiring`);
    assert.doesNotMatch(
      source,
      /state\.expires_at - currentUnixSeconds/,
      `${name}: must not recompute checkout countdown locally`,
    );
    assert.doesNotMatch(
      source,
      /transaction_state !== "settled"/,
      `${name}: must not own waiting-state settlement rule`,
    );
    assert.doesNotMatch(
      source,
      /formatOpenReceiveCountdown/,
      `${name}: must not format checkout countdown labels locally`,
    );
    assert.doesNotMatch(
      source,
      /getOpenReceivePaymentStatusText/,
      `${name}: must not compose checkout status text locally`,
    );
    assert.doesNotMatch(
      source,
      /shouldCheckoutShowWaiting/,
      `${name}: must not compose checkout waiting state locally`,
    );
    assert.doesNotMatch(
      source,
      /"Invoice expires in"/,
      `${name}: must not own countdown prefix text`,
    );
  }
});

test("Frontend UI packages consume shared transient feedback timing", () => {
  const reactSource = readReactSource();
  const elementsSource = readFileSync(
    path.join(process.cwd(), "packages/js/elements/src/index.ts"),
    "utf8",
  );

  for (const [name, source] of [
    ["react", reactSource],
    ["elements", elementsSource],
  ]) {
    assert.match(
      source,
      /createOpenReceiveTransientFeedbackController/,
      `${name}: uses browser transient feedback controller`,
    );
    assert.doesNotMatch(
      source,
      /globalThis\.setTimeout/,
      `${name}: must not own copy-feedback timers`,
    );
    assert.doesNotMatch(
      source,
      /setCopied\(false\)/,
      `${name}: must not locally reset copied state`,
    );
    assert.doesNotMatch(
      source,
      /setCopiedProviderId\(null\)/,
      `${name}: must not locally reset provider copied state`,
    );
  }
});

test("Frontend UI packages consume shared checkout labels", () => {
  const reactSource = readReactSource();
  const elementsSource = readFileSync(
    path.join(process.cwd(), "packages/js/elements/src/index.ts"),
    "utf8",
  );

  for (const [name, source] of [
    ["react", reactSource],
    ["elements", elementsSource],
  ]) {
    assert.match(source, /openReceiveCheckoutLabels/, `${name}: uses shared labels`);
    assert.match(
      source,
      /createCheckoutProviderCopyEvent/,
      `${name}: uses shared provider-copy event helper`,
    );
    assert.doesNotMatch(source, /"Pay this invoice"/, `${name}: wizard title is package-shared`);
    assert.doesNotMatch(source, /"Copy BOLT11"/, `${name}: copy label is package-shared`);
    assert.doesNotMatch(source, /"Waiting for payment"/, `${name}: status label is package-shared`);
    assert.doesNotMatch(
      source,
      /"Bitcoin Lightning invoice"/,
      `${name}: lightning invoice title is package-shared`,
    );
    assert.doesNotMatch(
      source,
      /"openreceive-provider-copy"/,
      `${name}: provider-copy event name is browser-shared`,
    );
    assert.doesNotMatch(
      source,
      /detail: \{ providerId \}/,
      `${name}: provider-copy event detail is browser-shared`,
    );
    assert.doesNotMatch(source, /`Open \$\{/, `${name}: provider action label is package-shared`);
    assert.doesNotMatch(
      source,
      /"Lightning Network"/,
      `${name}: route network label is package-shared`,
    );
    assert.doesNotMatch(source, /"Choose a country"/, `${name}: country prompt is package-shared`);
    assert.doesNotMatch(
      source,
      /"No providers found for this country yet\\."/,
      `${name}: empty state label is package-shared`,
    );
  }
});

test("Frontend UI packages consume shared checkout data attributes", () => {
  const reactSource = readReactSource();
  const elementsSource = readFileSync(
    path.join(process.cwd(), "packages/js/elements/src/index.ts"),
    "utf8",
  );

  for (const [name, source] of [
    ["react", reactSource],
    ["elements", elementsSource],
  ]) {
    assert.match(
      source,
      /OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES/,
      `${name}: uses browser-owned checkout data attributes`,
    );
    assert.doesNotMatch(
      source,
      /"data-openreceive-qr"/,
      `${name}: must not spell QR data attribute locally`,
    );
    assert.doesNotMatch(
      source,
      /"data-openreceive-theme-toggle"/,
      `${name}: must not spell theme-toggle data attribute locally`,
    );
  }
  assert.match(
    elementsSource,
    /OPENRECEIVE_CHECKOUT_DATA_SELECTORS/,
    "elements: uses browser-owned checkout data selectors",
  );
  assert.doesNotMatch(
    reactSource,
    /"data-openreceive-checkout"/,
    "react: must not spell checkout root data attribute locally",
  );
  assert.doesNotMatch(
    reactSource,
    /"data-openreceive-actions"/,
    "react: must not spell checkout actions data attribute locally",
  );
  assert.doesNotMatch(
    reactSource,
    /"data-openreceive-state"/,
    "react: must not spell checkout state data attribute locally",
  );
  assert.doesNotMatch(
    elementsSource,
    /querySelector\("\[data-openreceive-qr\]"\)/,
    "elements: must not hard-code checkout QR selector",
  );
});

test("Elements consume shared custom-element attribute contracts", () => {
  const elementsSource = readFileSync(
    path.join(process.cwd(), "packages/js/elements/src/index.ts"),
    "utf8",
  );

  assert.match(
    elementsSource,
    /OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES/,
    "elements: uses browser-owned checkout element attributes",
  );
  assert.match(
    elementsSource,
    /OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES/,
    "elements: uses browser-owned theme-toggle element attributes",
  );
  assert.match(
    elementsSource,
    /parseOpenReceiveOptionalInteger/,
    "elements: parses numeric attributes through browser helpers",
  );
  assert.match(
    elementsSource,
    /parseOpenReceiveBooleanAttribute/,
    "elements: parses boolean attributes through browser helpers",
  );
  assert.match(
    elementsSource,
    /parseOpenReceiveResolvedTheme/,
    "elements: parses checkout theme attributes through browser helpers",
  );
  assert.match(
    elementsSource,
    /parseOpenReceiveThemePreference/,
    "elements: parses theme preference attributes through browser helpers",
  );
  assert.doesNotMatch(
    elementsSource,
    /getAttribute\("invoice-id"\)/,
    "elements: must not hard-code invoice-id reads",
  );
  assert.doesNotMatch(
    elementsSource,
    /getAttribute\("order-url"\)/,
    "elements: must not hard-code order-url reads",
  );
  assert.doesNotMatch(
    elementsSource,
    /getAttribute\("root-selector"\)/,
    "elements: must not hard-code theme root selector reads",
  );
  assert.doesNotMatch(
    elementsSource,
    new RegExp(`setAttributeIfChanged\\("transaction-${"state"}`),
    "elements: must not hard-code raw lifecycle-state writes",
  );
  assert.doesNotMatch(
    elementsSource,
    /setAttributeIfChanged\("theme"/,
    "elements: must not hard-code theme writes",
  );
  assert.doesNotMatch(
    elementsSource,
    /function parseOptionalInteger/,
    "elements: must not own numeric attribute parsing",
  );
  assert.doesNotMatch(
    elementsSource,
    /function parseTheme/,
    "elements: must not own theme attribute parsing",
  );
  assert.doesNotMatch(
    elementsSource,
    /function parseBooleanAttribute/,
    "elements: must not own boolean attribute parsing",
  );
});

test("Elements consume shared theme-toggle event contract", () => {
  const elementsSource = readFileSync(
    path.join(process.cwd(), "packages/js/elements/src/index.ts"),
    "utf8",
  );

  assert.match(
    elementsSource,
    /createOpenReceiveThemeChangeEvent/,
    "elements: dispatches theme changes through browser event helper",
  );
  assert.doesNotMatch(
    elementsSource,
    /"openreceive-theme-change"/,
    "elements: must not hard-code theme-change event names",
  );
  assert.doesNotMatch(
    elementsSource,
    /resolvedTheme: nextTheme\.resolvedTheme/,
    "elements: must not compose theme-change event details locally",
  );
});

test("Elements consume shared checkout event constructors", () => {
  const elementsSource = readFileSync(
    path.join(process.cwd(), "packages/js/elements/src/index.ts"),
    "utf8",
  );

  assert.match(
    elementsSource,
    /createCheckoutActionEvent/,
    "elements: dispatches copy/open events through browser helpers",
  );
  assert.match(
    elementsSource,
    /createCheckoutStateEvent/,
    "elements: dispatches state events through browser helpers",
  );
  assert.match(
    elementsSource,
    /createCheckoutErrorEvent/,
    "elements: dispatches error events through browser helpers",
  );
  assert.doesNotMatch(
    elementsSource,
    /new CustomEvent\(OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS/,
    "elements: must not construct checkout custom events locally",
  );
  assert.doesNotMatch(
    elementsSource,
    /detail: \{ state \}/,
    "elements: must not compose checkout state event details locally",
  );
});

test("Elements consume shared web-component shadow part contracts", () => {
  const elementsSource = readFileSync(
    path.join(process.cwd(), "packages/js/elements/src/index.ts"),
    "utf8",
  );

  assert.match(
    elementsSource,
    /OPENRECEIVE_CHECKOUT_ELEMENT_PARTS/,
    "elements: renders checkout shadow parts from browser constants",
  );
  assert.match(
    elementsSource,
    /OPENRECEIVE_CHECKOUT_ELEMENT_PART_SELECTORS/,
    "elements: binds checkout shadow actions through browser selectors",
  );
  assert.match(
    elementsSource,
    /OPENRECEIVE_THEME_TOGGLE_ELEMENT_PARTS/,
    "elements: renders theme-toggle shadow parts from browser constants",
  );
  assert.match(
    elementsSource,
    /OPENRECEIVE_THEME_TOGGLE_ELEMENT_PART_SELECTORS/,
    "elements: binds theme-toggle actions through browser selectors",
  );
  assert.doesNotMatch(
    elementsSource,
    /querySelector\('\[part="copy"\]'\)/,
    "elements: must not hard-code copy part selectors",
  );
  assert.doesNotMatch(
    elementsSource,
    /querySelector\("button"\)/,
    "elements: must not hard-code theme-toggle button selectors",
  );
});

test("Frontend UI packages consume shared checkout display model", () => {
  const reactSource = readReactSource();
  const elementsSource = readFileSync(
    path.join(process.cwd(), "packages/js/elements/src/index.ts"),
    "utf8",
  );

  for (const [name, source] of [
    ["react", reactSource],
    ["elements", elementsSource],
  ]) {
    assert.match(
      source,
      /createCheckoutDisplayModel/,
      `${name}: uses browser-owned checkout display labels`,
    );
    assert.doesNotMatch(
      source,
      /function shortHash/,
      `${name}: must not own payment hash shortening`,
    );
    assert.doesNotMatch(
      source,
      /assertDisplaySafeInvoice/,
      `${name}: must not own display invoice safety checks`,
    );
    assert.doesNotMatch(
      source,
      /paymentHashLabel: shortHash/,
      `${name}: must not build hash labels locally`,
    );
  }
});

test("Frontend UI packages consume shared checkout display state conversion", () => {
  const reactSource = readReactSource();
  const elementsSource = readFileSync(
    path.join(process.cwd(), "packages/js/elements/src/index.ts"),
    "utf8",
  );

  for (const [name, source] of [
    ["react", reactSource],
    ["elements", elementsSource],
  ]) {
    assert.match(
      source,
      name === "react" ? /createCheckoutState/ : /createCheckoutStateFromDisplayData/,
      `${name}: creates checkout state from browser-owned display conversion`,
    );
    if (name === "elements") {
      assert.match(
        source,
        /createCheckoutSnapshotFromDisplayData/,
        `${name}: creates live snapshots from browser-owned display conversion`,
      );
    }
    assert.doesNotMatch(
      source,
      /function toCheckoutSnapshot/,
      `${name}: must not own display-to-snapshot mapping`,
    );
    assert.doesNotMatch(
      source,
      /invoice_id is required for checkout state/,
      `${name}: must not own checkout-state invoice id validation`,
    );
    assert.doesNotMatch(
      source,
      /invoice_id: options\.invoice_id/,
      `${name}: must not build React-style checkout snapshots locally`,
    );
    assert.doesNotMatch(
      source,
      /function currentUnixSeconds/,
      `${name}: must not own checkout countdown clock helpers`,
    );
  }
});

test("Elements consumes shared display HTML escaping", () => {
  const elementsSource = readFileSync(
    path.join(process.cwd(), "packages/js/elements/src/index.ts"),
    "utf8",
  );

  assert.match(
    elementsSource,
    /escapeOpenReceiveHtml/,
    "elements: escapes rendered HTML through browser helper",
  );
  assert.doesNotMatch(
    elementsSource,
    /function escapeHtml/,
    "elements: must not own HTML escaping implementation",
  );
  assert.doesNotMatch(
    elementsSource,
    /replaceAll\("&", "&amp;"\)/,
    "elements: must not duplicate HTML escape rules",
  );
});

test("Frontend UI packages consume shared wizard route display model", () => {
  const reactSource = readReactSource();
  const elementsSource = readFileSync(
    path.join(process.cwd(), "packages/js/elements/src/index.ts"),
    "utf8",
  );

  for (const [name, source] of [
    ["react", reactSource],
    ["elements", elementsSource],
  ]) {
    assert.match(
      source,
      /createOpenReceiveWizardRouteDisplays/,
      `${name}: uses shared wizard route display model`,
    );
    assert.doesNotMatch(
      source,
      /OPENRECEIVE_PROVIDER_PREVIEW_LIMIT/,
      `${name}: must not own provider preview slicing`,
    );
    assert.doesNotMatch(source, /route\.kind/, `${name}: must not own route heading decisions`);
    assert.doesNotMatch(
      source,
      /route\.providers\.slice/,
      `${name}: must not slice provider previews locally`,
    );
    assert.doesNotMatch(
      source,
      /entry\.flagship/,
      `${name}: must not own recommended provider labels`,
    );
    assert.doesNotMatch(
      source,
      /entry\.provider/,
      `${name}: must not own raw provider display fields`,
    );
    assert.doesNotMatch(
      source,
      /getCheckoutProviderMechanismLabel/,
      `${name}: must not compose provider badges locally`,
    );
    assert.doesNotMatch(
      source,
      /getCheckoutProviderOpenLabel/,
      `${name}: must not compose provider links locally`,
    );
    assert.doesNotMatch(
      source,
      /getCheckoutProviderUsBadge/,
      `${name}: must not compose provider US badges locally`,
    );
  }
});

test("Frontend UI packages consume shared wizard selection model", () => {
  const reactSource = readReactSource();
  const elementsSource = readFileSync(
    path.join(process.cwd(), "packages/js/elements/src/index.ts"),
    "utf8",
  );

  for (const [name, source] of [
    ["react", reactSource],
    ["elements", elementsSource],
  ]) {
    assert.match(
      source,
      /createOpenReceivePaymentWizardModel/,
      `${name}: derives wizard view model from browser helper`,
    );
    assert.match(
      source,
      /updateOpenReceivePaymentWizardSelection|createOpenReceivePaymentWizardController/,
      `${name}: updates wizard selection through browser-owned selection logic`,
    );
    assert.doesNotMatch(
      source,
      /setSelectedMethod/,
      `${name}: must not own method selection transitions`,
    );
    assert.doesNotMatch(
      source,
      /setSelectedCountryCode/,
      `${name}: must not own country selection transitions`,
    );
  }
  assert.match(
    elementsSource,
    /OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES/,
    "elements: renders wizard DOM attributes from browser constants",
  );
  assert.match(
    elementsSource,
    /OPENRECEIVE_PAYMENT_WIZARD_SELECTORS/,
    "elements: binds wizard DOM events through browser selectors",
  );
  assert.match(
    elementsSource,
    /parseOpenReceivePaymentMethod/,
    "elements: parses wizard methods through browser helper",
  );
  assert.match(
    elementsSource,
    /parseOpenReceiveRegion/,
    "elements: parses wizard regions through browser helper",
  );
  assert.doesNotMatch(
    elementsSource,
    /querySelectorAll\("\[data-or-/,
    "elements: must not hard-code wizard query selectors",
  );
  assert.doesNotMatch(
    elementsSource,
    /getAttribute\("data-or-/,
    "elements: must not hard-code wizard attribute reads",
  );
});

test("Frontend UI packages consume shared country dropdown model", () => {
  const reactSource = readReactSource();
  const elementsSource = readFileSync(
    path.join(process.cwd(), "packages/js/elements/src/index.ts"),
    "utf8",
  );

  assert.match(
    reactSource,
    /model\.countryDisplays/,
    "react: renders countries from browser display model",
  );
  assert.match(
    reactSource,
    /renderCountrySelect/,
    "react: renders a package-owned country dropdown",
  );
  assert.doesNotMatch(
    reactSource,
    /projectMapPoint/,
    "react: must not re-project country map pins",
  );
  assert.doesNotMatch(
    reactSource,
    /geoNaturalEarth1/,
    "react: must not own country map projection",
  );
  assert.doesNotMatch(reactSource, /world-atlas/, "react: must not own country map atlas data");
  assert.doesNotMatch(
    reactSource,
    /topojson-client/,
    "react: must not own country map feature extraction",
  );
  assert.match(
    elementsSource,
    /model\.countryDisplays/,
    "elements: renders countries from browser display model",
  );
  assert.match(
    elementsSource,
    /renderCountrySelectHtml/,
    "elements: renders a package-owned country dropdown",
  );
  assert.doesNotMatch(
    elementsSource,
    /part="country-map"/,
    "elements: must not render the old country map",
  );
  for (const [name, source] of [
    ["react", reactSource],
    ["elements", elementsSource],
  ]) {
    assert.doesNotMatch(
      source,
      /openReceiveCountryPins/,
      `${name}: must not own country map pin data`,
    );
    assert.doesNotMatch(
      source,
      /openReceiveRegionLabels/,
      `${name}: must not own region display labels`,
    );
    assert.doesNotMatch(
      source,
      /getOpenReceiveCoverageLabel/,
      `${name}: must not compose country coverage labels locally`,
    );
    assert.doesNotMatch(
      source,
      /country\.currency.*country\.coverage/s,
      `${name}: must not compose country meta labels locally`,
    );
  }
});

test("Frontend UI packages consume shared payment icon helpers", () => {
  const reactSource = readReactSource();
  const elementsSource = readFileSync(
    path.join(process.cwd(), "packages/js/elements/src/index.ts"),
    "utf8",
  );

  for (const [name, source] of [
    ["react", reactSource],
    ["elements", elementsSource],
  ]) {
    assert.match(
      source,
      /getOpenReceivePaymentMethodIcon/,
      `${name}: method icons come from the browser package`,
    );
    assert.match(
      source,
      /createOpenReceiveWizardRouteAssetDisplays/,
      `${name}: route asset rows come from the browser package`,
    );
    assert.doesNotMatch(
      source,
      /getOpenReceiveRouteIcon/,
      `${name}: must not build route icon rows locally`,
    );
    assert.doesNotMatch(
      source,
      /getOpenReceiveRouteNetworkLabel/,
      `${name}: must not build route subtitles locally`,
    );
    assert.doesNotMatch(
      source,
      /asset\.route \?\? asset\.symbol/,
      `${name}: must not resolve route ids locally`,
    );
    assert.doesNotMatch(
      source,
      /new URL\("\.\/assets\/icons/,
      `${name}: must not own checkout icon asset URLs`,
    );
  }
});

test("Hello Fruit JS demos set up package-owned invoice persistence", () => {
  const helper = readFileSync(
    path.join(process.cwd(), "examples/hello-fruit/shared/openreceive-store.ts"),
    "utf8",
  );
  const postgresStore = readFileSync(
    path.join(process.cwd(), "packages/js/node/src/postgres-store.ts"),
    "utf8",
  );
  assert.match(helper, /resolveOpenReceiveStore/);
  assert.match(helper, /readOpenReceiveConfigFile/);
  assert.match(helper, /openreceive\.yml/);
  assert.doesNotMatch(helper, /OPENRECEIVE_STORE/);
  assert.doesNotMatch(helper, /OPENRECEIVE_NAMESPACE/);
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
      readFileSync(path.join(process.cwd(), demoDir, "package.json"), "utf8"),
    );
    const compose = readFileSync(path.join(process.cwd(), demoDir, "compose.yml"), "utf8");
    const volumeName = demoDir.split("/").at(-1);

    assert.equal(packageJson.dependencies.pg, "^8.22.0", `${demoDir}: pg dependency`);
    assert.doesNotMatch(compose, /OPENRECEIVE_STORE/);
    assert.doesNotMatch(compose, /OPENRECEIVE_NAMESPACE/);
    assert.doesNotMatch(compose, /DATABASE_URL/);
    assert.doesNotMatch(compose, /openreceive-postgres/);
    assert.doesNotMatch(compose, /image:\s+postgres:17-alpine/);
    assert.match(compose, /openreceive\.yml:.+openreceive\.yml:ro/);
    assert.match(compose, new RegExp(`openreceive-${volumeName}-openreceive:.+\\.openreceive`));
  }

  for (const sourcePath of [
    "examples/hello-fruit/server/node-express/src/server/create-server.ts",
    "examples/hello-fruit/server/static-html-small-api/src/server/create-server.ts",
    "examples/hello-fruit/server/nextjs-fullstack/src/server/openreceive.ts",
  ]) {
    const source = readFileSync(path.join(process.cwd(), sourcePath), "utf8");
    assert.match(source, /createOpenReceive/);
    assert.doesNotMatch(source, /createHelloFruitOpenReceiveKvStore/);
    assert.doesNotMatch(source, /createOpenReceivePriceFeed/);
    assert.doesNotMatch(source, /new InMemoryInvoiceStore\(\)/);
    assert.doesNotMatch(source, /OPENRECEIVE_POSTGRES_MIGRATION_SQL/);
    assert.doesNotMatch(source, /OPENRECEIVE_DATABASE_SCHEMA_VERSION/);
  }

  for (const demoDir of demoServerDirs) {
    assert.equal(
      existsSync(path.join(process.cwd(), demoDir, "openreceive.config.mjs")),
      false,
      `${demoDir}: openreceive.yml is the only demo config file`,
    );
  }
});

test("Next.js demo prepares orders and mounts the shipped OpenReceive router", () => {
  const source = readFileSync(
    path.join(
      process.cwd(),
      "examples/hello-fruit/server/nextjs-fullstack/src/server/openreceive.ts",
    ),
    "utf8",
  );

  assert.match(source, /createOpenReceive/);
  // The app owns cart validation via prepareCheckout; OpenReceive persists amount + summary.
  assert.match(source, /createHelloFruitPrepareCheckout/);
  assert.match(source, /openReceiveHttpOptions/);
  assert.match(source, /prepareCheckout/);
  assert.match(source, /guestCheckout\(\)/);
  assert.match(source, /readRequiredHelloFruitNwcConnectionString/);
  assert.doesNotMatch(source, /prepareOrderResponse/);
  assert.doesNotMatch(source, /prepareHelloFruitOrder/);
  assert.doesNotMatch(source, /createHelloFruitOrderStore/);
  assert.doesNotMatch(source, /mapHostRouteError/);
  assert.doesNotMatch(source, /openreceive\.getOrCreateCheckout/);
  assert.doesNotMatch(source, /openreceive\.order\(/);
  // The @openreceive/next mount lives in the catch-all route file, not this app-service module.
  assert.doesNotMatch(source, /@openreceive\/next/);
  assert.doesNotMatch(source, /dispatchOpenReceiveRoute/);
  assert.doesNotMatch(source, /matchOpenReceiveRoute/);
  assert.doesNotMatch(source, /createNwcReceiveClient/);
  assert.doesNotMatch(source, /createOpenReceiveNextRuntime/);
  assert.doesNotMatch(source, /dispatchOpenReceiveNextNoWalletRoute/);
  assert.doesNotMatch(source, /class CapturedResponse/);
  assert.doesNotMatch(source, /ExpressLikeRequest/);
  assert.doesNotMatch(source, /ReadableStream<Uint8Array>/);
  assert.doesNotMatch(source, /formatSseEvent/);
  assert.doesNotMatch(source, /parseLastEventId/);

  // The shipped router is mounted as an App Router catch-all — one file, no hand-written routes.
  const mount = readFileSync(
    path.join(
      process.cwd(),
      "examples/hello-fruit/server/nextjs-fullstack/src/app/openreceive/[...openreceive]/route.ts",
    ),
    "utf8",
  );
  assert.match(mount, /openReceiveNextHandlers/);
  assert.match(mount, /@openreceive\/next/);
  assert.match(mount, /openReceiveHttpOptions/);

  // The old hand-written OpenReceive route handlers are gone.
  assert.equal(
    existsSync(
      path.join(process.cwd(), "examples/hello-fruit/server/nextjs-fullstack/src/app/create_order"),
    ),
    false,
  );
  assert.equal(
    existsSync(
      path.join(process.cwd(), "examples/hello-fruit/server/nextjs-fullstack/src/app/order"),
    ),
    false,
  );
});

test("Hello Fruit demos mount OpenReceive with prepareCheckout", () => {
  for (const sourcePath of [
    "examples/hello-fruit/server/node-express/src/server/create-server.ts",
    "examples/hello-fruit/server/static-html-small-api/src/server/create-server.ts",
    "examples/hello-fruit/server/nextjs-fullstack/src/server/openreceive.ts",
  ]) {
    const source = readFileSync(path.join(process.cwd(), sourcePath), "utf8");
    assert.match(source, /prepareCheckout/, sourcePath);
    assert.match(source, /createHelloFruitPrepareCheckout|createOpenReceive/, sourcePath);
    assert.match(source, /guestCheckout\(\)/, sourcePath);
    assert.doesNotMatch(source, /getCheckoutAmount/, sourcePath);
    assert.doesNotMatch(source, /\/prepare_order/, sourcePath);
  }
});

test("Hello Fruit server demos keep secret-safe local setup docs", () => {
  const openReceiveExamplePath = path.join(process.cwd(), "openreceive.yml.example");
  assert.equal(existsSync(openReceiveExamplePath), true, "openreceive.yml.example");

  const openReceiveExample = readFileSync(openReceiveExamplePath, "utf8");
  assert.match(openReceiveExample, /^OPENRECEIVE_NWC:\s*""$/m, "placeholder NWC");
  assert.match(openReceiveExample, /^OPENRECEIVE_NAMESPACE:\s+default$/m);
  assert.match(openReceiveExample, /^OPENRECEIVE_STORE:\s+local-sqlite$/m);
  assert.match(openReceiveExample, /^\s+key:\s*""$/m);
  assert.match(openReceiveExample, /^\s+secret:\s*""$/m);
  assert.match(openReceiveExample, /^sentry:\s*$/m);
  assert.match(openReceiveExample, /^\s+dsn:\s*""$/m);
  assert.doesNotMatch(openReceiveExample, /nostr\+walletconnect:\/\//);

  for (const demoDir of demoServerDirs) {
    const readmePath = path.join(process.cwd(), demoDir, "README.md");
    const dockerfilePath = path.join(process.cwd(), demoDir, "Dockerfile");
    const composePath = path.join(process.cwd(), demoDir, "compose.yml");
    const composeOverridePath = path.join(process.cwd(), demoDir, "compose.override.yml.example");

    assert.equal(existsSync(readmePath), true, `${demoDir}: README.md`);
    assert.equal(existsSync(dockerfilePath), true, `${demoDir}: Dockerfile`);
    assert.equal(existsSync(composePath), true, `${demoDir}: compose.yml`);
    assert.equal(existsSync(composeOverridePath), true, `${demoDir}: compose.override.yml.example`);

    const readme = readFileSync(readmePath, "utf8");
    const dockerfile = readFileSync(dockerfilePath, "utf8");
    const compose = readFileSync(composePath, "utf8");
    const composeOverride = readFileSync(composeOverridePath, "utf8");

    assert.match(readme, /The browser never receives `OPENRECEIVE_NWC`\./);
    assert.match(readme, /valid receive-only `OPENRECEIVE_NWC`/);
    assert.match(readme, /openreceive\.yml\.example/);
    assert.match(readme, /\/demo-metadata\.json/);
    assert.match(readme, /compose\.override\.yml\.example up --build/);
    assert.doesNotMatch(readme, /--profile openreceive-worker/);
    assert.match(dockerfile, /CMD \["npm", "start"\]/);
    assert.doesNotMatch(compose, /env_file:/);
    assert.match(compose, /openreceive\.yml:.+openreceive\.yml:ro/);
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
    await withTempCwd(async () => {
      for (const demo of [
        {
          name: "node-express-production",
          createApp: createHelloFruitProductionServer,
        },
        {
          name: "static-html-small-api-production",
          createApp: createHelloFruitStaticProductionServer,
        },
      ]) {
        await assert.rejects(
          () => demo.createApp(),
          /needs a receive-only NWC code to receive payments\.[\s\S]+https:\/\/openreceive\.org\/get_a_nwc_code_to_receive_payments/,
          `${demo.name}: requires NWC at boot`,
        );
      }

      assert.throws(
        () => getNextDemoMetadata(),
        /needs a receive-only NWC code to receive payments\.[\s\S]+https:\/\/openreceive\.org\/get_a_nwc_code_to_receive_payments/,
        "nextjs-fullstack: metadata requires NWC",
      );
    });
  });
});

test("Hello Fruit demos refuse malformed OPENRECEIVE_NWC before serving", async () => {
  await withEnv({ OPENRECEIVE_NWC: undefined }, async () => {
    await withTempCwd(async (dir) => {
      writeFileSync(path.join(dir, "openreceive.yml"), 'OPENRECEIVE_NWC: "https://example.com"\n');
      await assert.rejects(
        () => createHelloFruitServer(),
        /OPENRECEIVE_NWC is set, but it is not a valid NWC code\.[\s\S]+NWC URI must use nostr\+walletconnect\.[\s\S]+https:\/\/openreceive\.org\/get_a_nwc_code_to_receive_payments/,
      );
      await assert.rejects(
        () => createHelloFruitStaticServer(),
        /OPENRECEIVE_NWC is set, but it is not a valid NWC code\.[\s\S]+NWC URI must use nostr\+walletconnect\.[\s\S]+https:\/\/openreceive\.org\/get_a_nwc_code_to_receive_payments/,
      );
      assert.throws(
        () => getNextDemoMetadata(),
        /OPENRECEIVE_NWC is set, but it is not a valid NWC code\.[\s\S]+NWC URI must use nostr\+walletconnect\.[\s\S]+https:\/\/openreceive\.org\/get_a_nwc_code_to_receive_payments/,
      );
    });
  });
});

test("Hello Fruit metadata exposes only allowlisted build fields", async () => {
  await withEnv(
    {
      OPENRECEIVE_DEMO_MODE: "production",
      OPENRECEIVE_GIT_SHA: "0123456789abcdef",
      OPENRECEIVE_IMAGE_DIGEST: `sha256:${"c".repeat(64)}`,
      OPENRECEIVE_DEPLOYED_AT: "2026-06-20T12:34:56Z",
    },
    async () => {
      for (const demo of [
        {
          name: "node-express",
          createApp: createHelloFruitServer,
        },
        {
          name: "static-html-small-api",
          createApp: createHelloFruitStaticServer,
        },
      ]) {
        const metadata = await getJson(
          await demo.createApp(createHelloFruitTestOpenReceiveOptions()),
          "/demo-metadata.json",
        );
        assert.equal(metadata.status, 200, `${demo.name}: metadata status`);
        assert.equal(metadata.body.mode, "production");
        assert.equal(metadata.body.build.git_sha, "0123456789abcdef");
        assert.equal(metadata.body.build.image_digest, `sha256:${"c".repeat(64)}`);
        assert.equal(metadata.body.build.deployed_at, "2026-06-20T12:34:56Z");
        assert.equal(JSON.stringify(metadata.body).includes("OPENRECEIVE_NWC"), false);
        assert.equal(JSON.stringify(metadata.body).includes("nostr+walletconnect://"), false);
        assert.equal(JSON.stringify(metadata.body).includes("secret="), false);
      }

      setHelloFruitOpenReceiveTestOverrides(createHelloFruitTestOpenReceiveOptions());
      try {
        const nextMetadata = await responseJson(getNextDemoMetadata());
        assert.equal(nextMetadata.status, 200, "nextjs-fullstack: metadata status");
        assert.equal(nextMetadata.body.mode, "production");
        assert.equal(nextMetadata.body.build.git_sha, "0123456789abcdef");
        assert.equal(nextMetadata.body.build.image_digest, `sha256:${"c".repeat(64)}`);
        assert.equal(nextMetadata.body.build.deployed_at, "2026-06-20T12:34:56Z");
        assert.equal(JSON.stringify(nextMetadata.body).includes("OPENRECEIVE_NWC"), false);
        assert.equal(JSON.stringify(nextMetadata.body).includes("nostr+walletconnect://"), false);
        assert.equal(JSON.stringify(nextMetadata.body).includes("secret="), false);
      } finally {
        setHelloFruitOpenReceiveTestOverrides(undefined);
      }
    },
  );
});

test("Hello Fruit demos prepare app orders and settle through the mounted router", async () => {
  const orderRequest = {
    cart: [
      { product_id: "banana", quantity: 2 },
      { product_id: "apple", quantity: 1 },
    ],
  };

  for (const demo of [
    {
      name: "node-express",
      createApp: createHelloFruitServer,
    },
    {
      name: "static-html-small-api",
      createApp: createHelloFruitStaticServer,
    },
  ]) {
    const options = createHelloFruitTestOpenReceiveOptions();
    const app = await demo.createApp(options);

    // 1. Shipped prepare: validate cart + persist amount (+ summary).
    const prepared = await dispatchJson(app, "POST", "/openreceive/prepare", orderRequest);
    assert.equal(prepared.status, 201, `${demo.name}: prepare status`);
    assert.match(prepared.body.order_id, /_/);
    assert.equal(prepared.body.summary.status, "pending_payment");
    assert.equal(prepared.body.summary.total_amount.currency, "USD");
    assert.equal(prepared.body.summary.total_amount.value, "10.00");
    assert.equal(prepared.body.summary.items.length, 2);
    assert.equal(prepared.body.checkout, undefined, `${demo.name}: prepare returns no checkout`);
    const orderId = prepared.body.order_id;

    // Guest resume: shipped summary route (no capability token).
    const summary = await dispatchJson(
      app,
      "GET",
      `/openreceive/orders/${encodeURIComponent(orderId)}/summary`,
    );
    assert.equal(summary.status, 200, `${demo.name}: order summary status`);
    assert.equal(summary.body.order_id, orderId);
    assert.equal(summary.body.summary.uuid, orderId);
    assert.equal(summary.body.summary.total_amount.value, "10.00");
    assert.equal(summary.body.order_access_token, undefined);
    const missing = await dispatchJson(app, "GET", "/openreceive/orders/does-not-exist/summary");
    assert.equal(missing.status, 404, `${demo.name}: missing order summary`);

    // 2. Mounted router creates the checkout from just { order_id } (prepareCheckout is the authority)
    // and mints the per-order capability token, returned once.
    const created = await dispatchJson(app, "POST", "/openreceive/checkouts", { order_id: orderId });
    assert.equal(created.status, 201, `${demo.name}: create checkout status`);
    assert.equal(created.body.checkout.order_id, orderId);
    const token = created.body.order_access_token;
    assert.equal(typeof token, "string", `${demo.name}: mints an order access token`);
    const createdInvoice = created.body.checkout.active ?? created.body.checkout.invoices[0];
    assert.equal(typeof createdInvoice.invoice, "string");
    assert.equal(JSON.stringify(created.body).includes("nostr+walletconnect://"), false);

    // Idempotency: a second create for the same order replays the same checkout, no new token.
    const second = await dispatchJson(app, "POST", "/openreceive/checkouts", { order_id: orderId });
    assert.equal(second.status, 201, `${demo.name}: second create checkout status`);
    assert.equal(second.body.checkout.order_id, orderId);
    assert.equal(second.body.order_access_token, undefined, `${demo.name}: token minted once`);

    // 3. Settle the invoice in the fake wallet, then poll order status with the capability token.
    options.client.settleAll();
    await resetTransactionScanGate(options.store);
    const status = await dispatchJson(
      app,
      "POST",
      `/openreceive/orders/${orderId}`,
      {},
      { authorization: `Bearer ${token}` },
    );
    assert.equal(status.status, 200, `${demo.name}: order status`);
    assert.equal(status.body.order_id, orderId);
    assert.equal(status.body.status, "paid", `${demo.name}: settled order is paid`);
    // Payable swap assets ride on the order status itself (swap_pay_options).
    assert.ok(Array.isArray(status.body.swap_pay_options));
    const statusInvoice =
      status.body.display_checkout.active ?? status.body.display_checkout.invoices[0];
    assert.equal(statusInvoice.payment_hash, createdInvoice.payment_hash);

    // Without the token, the per-order read is denied by the guestCheckout() policy.
    const denied = await dispatchJson(app, "POST", `/openreceive/orders/${orderId}`, {});
    assert.equal(denied.status, 403, `${demo.name}: read without token is forbidden`);
  }

  const options = createHelloFruitTestOpenReceiveOptions();
  setHelloFruitOpenReceiveTestOverrides(options);
  try {
    const prepared = await responseJson(
      postNextOpenReceive(jsonRequest("/openreceive/prepare", orderRequest)),
    );
    assert.equal(prepared.status, 201, "nextjs-fullstack: prepare status");
    assert.match(prepared.body.order_id, /_/);
    assert.equal(prepared.body.summary.total_amount.value, "10.00");
    assert.equal(prepared.body.checkout, undefined);
    const orderId = prepared.body.order_id;

    const summary = await responseJson(
      getNextOpenReceive(new Request(`http://localhost/openreceive/orders/${encodeURIComponent(orderId)}/summary`)),
    );
    assert.equal(summary.status, 200, "nextjs-fullstack: order summary status");
    assert.equal(summary.body.order_id, orderId);
    assert.equal(summary.body.summary.uuid, orderId);
    assert.equal(summary.body.order_access_token, undefined);

    const created = await responseJson(
      postNextOpenReceive(jsonRequest("/openreceive/checkouts", { order_id: orderId })),
    );
    assert.equal(created.status, 201, "nextjs-fullstack: create checkout status");
    assert.equal(created.body.checkout.order_id, orderId);
    const token = created.body.order_access_token;
    assert.equal(typeof token, "string");

    const second = await responseJson(
      postNextOpenReceive(jsonRequest("/openreceive/checkouts", { order_id: orderId })),
    );
    assert.equal(second.status, 201, "nextjs-fullstack: second create checkout status");
    assert.equal(second.body.order_access_token, undefined);

    options.client.settleAll();
    await resetTransactionScanGate(options.store);
    const nextStatus = await responseJson(
      postNextOpenReceive(
        jsonRequest(
          `/openreceive/orders/${orderId}`,
          {},
          { authorization: `Bearer ${token}` },
        ),
      ),
    );
    assert.equal(nextStatus.status, 200, "nextjs-fullstack: order status");
    assert.equal(nextStatus.body.order_id, orderId);
    assert.equal(nextStatus.body.status, "paid");
    assert.ok(Array.isArray(nextStatus.body.swap_pay_options));
  } finally {
    setHelloFruitOpenReceiveTestOverrides(undefined);
  }
});

test("Hello Fruit demos create direct SATS orders from the currency switcher", async () => {
  const orderRequest = {
    currency: "SATS",
    cart: [
      { product_id: "banana", quantity: 2 },
      { product_id: "apple", quantity: 1 },
    ],
  };

  for (const demo of [
    {
      name: "node-express",
      createApp: createHelloFruitServer,
    },
    {
      name: "static-html-small-api",
      createApp: createHelloFruitStaticServer,
    },
  ]) {
    const app = await demo.createApp(createHelloFruitTestOpenReceiveOptions());
    const prepared = await dispatchJson(app, "POST", "/openreceive/prepare", orderRequest);
    assert.equal(prepared.status, 201, `${demo.name}: prepare status`);
    assert.equal(prepared.body.summary.total_amount.currency, "SATS");
    assert.equal(prepared.body.summary.total_amount.value, "20000");
    const orderId = prepared.body.order_id;

    // The SATS amount is the amount authority: prepareCheckout looks the persisted order up by id, so
    // the mounted create-checkout route mints a direct-sats invoice with no fiat quote.
    const created = await dispatchJson(app, "POST", "/openreceive/checkouts", { order_id: orderId });
    assert.equal(created.status, 201, `${demo.name}: create checkout status`);
    assert.equal(created.body.checkout.amount_msats, 20000000);
    const createdInvoice = created.body.checkout.active ?? created.body.checkout.invoices[0];
    assert.equal(createdInvoice.fiat_quote, null);
  }
});

test("Hello Fruit hosted demo routes expose source, docs, robots, and sitemap", async () => {
  await withEnv(
    {
      OPENRECEIVE_PUBLIC_URL: "https://demo.example.test",
      OPENRECEIVE_DEMO_NOINDEX: undefined,
    },
    async () => {
      for (const demo of [
        {
          name: "node-express",
          sourcePath: "examples/hello-fruit/server/node-express",
          createApp: createHelloFruitServer,
        },
        {
          name: "static-html-small-api",
          sourcePath: "examples/hello-fruit/server/static-html-small-api",
          createApp: createHelloFruitStaticServer,
        },
      ]) {
        const app = await demo.createApp(createHelloFruitTestOpenReceiveOptions());
        const source = await dispatch(app, {
          method: "GET",
          url: "/source",
          headers: {},
        });
        assert.equal(source.status, 302, `${demo.name}: source status`);
        assert.equal(
          source.headers.get("location"),
          `https://github.com/openreceive/openreceive/tree/main/${demo.sourcePath}`,
        );

        const docs = await dispatch(app, {
          method: "GET",
          url: "/docs",
          headers: {},
        });
        assert.equal(docs.status, 302, `${demo.name}: docs status`);
        assert.equal(
          docs.headers.get("location"),
          "https://github.com/openreceive/openreceive/blob/main/docs/guides/quickstart-node.md",
        );

        const robots = await dispatch(app, {
          method: "GET",
          url: "/robots.txt",
          headers: {},
        });
        assert.equal(robots.status, 200, `${demo.name}: robots status`);
        assert.match(robots.text, /Allow: \//);
        assert.match(robots.text, /Sitemap: https:\/\/demo\.example\.test\/sitemap\.xml/);

        const sitemap = await dispatch(app, {
          method: "GET",
          url: "/sitemap.xml",
          headers: {},
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
        "https://github.com/openreceive/openreceive/tree/main/examples/hello-fruit/server/nextjs-fullstack",
      );

      const nextDocs = getNextDocs();
      assert.equal(nextDocs.status, 302, "nextjs-fullstack: docs status");
      assert.equal(
        nextDocs.headers.get("location"),
        "https://github.com/openreceive/openreceive/blob/main/docs/guides/frontend-checkout.md",
      );

      assert.equal(nextRobotsDynamic, "force-dynamic");
      const nextRobots = getNextRobots();
      assert.deepEqual(nextRobots.rules, {
        userAgent: "*",
        allow: "/",
      });
      assert.equal(nextRobots.sitemap, "https://demo.example.test/sitemap.xml");

      assert.equal(nextSitemapDynamic, "force-dynamic");
      const nextSitemap = getNextSitemap();
      assert.equal(nextSitemap[0]?.url, "https://demo.example.test");
      assert.equal(JSON.stringify(nextRobots).includes("OPENRECEIVE_NWC"), false);
      assert.equal(JSON.stringify(nextSitemap).includes("nostr+walletconnect://"), false);
    },
  );
});

async function responseJson(responseOrPromise) {
  const response = await responseOrPromise;
  return {
    status: response.status,
    body: await response.json(),
  };
}

function jsonRequest(pathname, body, headers = {}) {
  return new Request(`http://localhost${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function getJson(app, url) {
  return await dispatchJson(app, "GET", url);
}

async function dispatchJson(app, method, url, body, headers = {}) {
  const response = await dispatch(app, {
    method,
    url,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body,
  });

  return {
    status: response.status,
    body: JSON.parse(response.text),
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
      },
    });
    req.method = options.method;
    req.url = options.url;
    req.headers = {
      ...options.headers,
      ...(payload === undefined ? {} : { "content-length": String(payload.length) }),
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
          headers,
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
      },
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

async function withTempCwd(callback) {
  const previous = process.cwd();
  const dir = mkdtempSync(path.join(tmpdir(), "openreceive-demo-test-"));
  try {
    process.chdir(dir);
    await callback(dir);
  } finally {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
}
