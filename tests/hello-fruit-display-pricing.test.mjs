// The Hello Fruit shop over an untrusted /rates payload.
//
// Every demo fetches GET /rates and hands the body straight to the price
// display that runs inside render (the fruit grid, each cart row, the buy-now
// label). A body the demo server should never have sent must therefore cost
// the converted PRICE — the shop falls back to its USD catalog amounts — and
// never the screen.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://hello-fruit.local/" });

process.env.LOG_LEVEL ??= "error";

const assert = (await import("node:assert/strict")).default;
const test = (await import("node:test")).default;
const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
const { until } = await import("./helpers/lifecycle-harness.mjs");
const { HelloFruitShopApp } = await import("../examples/hello-fruit/shared/demo-shop-app.tsx");
const { convertHelloFruitUsdAmount, parseHelloFruitBtcFiatRates, toHelloFruitDisplayAmount } =
  await import("../examples/hello-fruit/shared/demo-pricing.ts");

const fruits = [
  {
    id: "apple",
    name: "Apple",
    sticker: "stickers/apple.png",
    fiat: { currency: "USD", value: "2.00" },
  },
  {
    id: "banana",
    name: "Banana",
    sticker: "stickers/banana.png",
    fiat: { currency: "USD", value: "3.50" },
  },
];

const originalGlobalFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = originalGlobalFetch;
});

/** Let React flush its passive effects (they are scheduled as a macrotask). */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Mount the real shop app with the real rates effect, answering its GET /rates
 * with `ratesBody`. Render errors are captured instead of escaping so a broken
 * render fails as an assertion rather than an unhandled rejection.
 */
function mountShop(ratesBody) {
  globalThis.fetch = async (input) => {
    const url = String(typeof input === "string" ? input : input.url);
    if (!url.includes("/rates")) throw new Error(`unexpected fetch: ${url}`);
    return new Response(JSON.stringify(ratesBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const events = [];
  const errors = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container, {
    onUncaughtError: (error) => errors.push(error),
    onCaughtError: (error) => errors.push(error),
  });
  root.render(
    React.createElement(HelloFruitShopApp, {
      logDemo: (event) => events.push(event),
      product: { name: "Hello Fruit", description: "Fruit stickers, paid over Lightning." },
      fruits,
      onEnterCheckout: () => undefined,
      onExitCheckout: () => undefined,
      renderCheckout: () => React.createElement("div"),
    }),
  );

  return {
    events,
    errors,
    text: () => container.textContent ?? "",
    /** Wait for the rates effect to settle, then pick a bitcoin display currency. */
    async selectCurrency(currency) {
      await until(() => events.some((event) => event.startsWith("rates.")), {
        label: "the /rates effect to settle",
      });
      const select = container.querySelector("select");
      assert.ok(select, "the shop must render its currency picker");
      select.value = currency;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await flush();
    },
    unmount() {
      root.unmount();
      container.remove();
    },
  };
}

test("a usable /rates payload prices the shop in the selected bitcoin unit", async () => {
  const shop = mountShop({ rates: { bitcoin: { usd: "100000" } } });
  try {
    await shop.selectCurrency("SATS");
    assert.deepEqual(shop.errors, []);
    // $2.00 and $3.50 at $100,000/BTC.
    assert.match(shop.text(), /2000 sats/);
    assert.match(shop.text(), /3500 sats/);
  } finally {
    shop.unmount();
  }
});

test("a malformed /rates payload leaves the shop rendering at its base prices", async () => {
  // A rate the money engine cannot parse: `OpenReceivePriceFeedError` from
  // `parseBtcFiatPrice`, which is deliberately NOT an `OpenReceiveDecimalError`.
  const shop = mountShop({ rates: { bitcoin: { usd: "unavailable" } } });
  try {
    await shop.selectCurrency("SATS");
    assert.deepEqual(
      shop.errors.map((error) => String(error)),
      [],
      "a malformed rates body must not take down the shop",
    );
    assert.match(shop.text(), /\$2\.00/);
    assert.match(shop.text(), /\$3\.50/);
  } finally {
    shop.unmount();
  }
});

test("a /rates payload with no bitcoin map leaves the shop rendering", async () => {
  // The shape a bare cast trusts hardest: `body.rates` is present but empty, so
  // `rates.bitcoin[...]` is a TypeError, not a price-feed error.
  const shop = mountShop({ rates: {} });
  try {
    await shop.selectCurrency("BTC");
    assert.deepEqual(
      shop.errors.map((error) => String(error)),
      [],
      "an empty rates body must not take down the shop",
    );
    assert.match(shop.text(), /\$2\.00/);
  } finally {
    shop.unmount();
  }
});

test("the rates parse boundary keeps the usable currencies and drops the rest", () => {
  assert.deepEqual(
    parseHelloFruitBtcFiatRates({
      bitcoin: {
        usd: "100000",
        eur: 90000, // a JSON number is usable; the money engine wants the string
        gbp: "0", // a zero price is a feed outage, not a rate
        jpy: "0.1e8", // BigDecimal#to_s form the money engine cannot parse
        chf: null,
        bitcoin: "1", // not a three-letter currency code
      },
    }),
    { bitcoin: { usd: "100000", eur: "90000" } },
  );
});

test("the rates parse boundary answers undefined for every unusable body", () => {
  for (const payload of [
    undefined,
    null,
    "rates",
    [],
    {},
    { bitcoin: null },
    { bitcoin: [] },
    { bitcoin: {} },
    { bitcoin: { usd: "unavailable" } },
    { rates: { bitcoin: { usd: "100000" } } }, // already unwrapped by the caller
  ]) {
    assert.equal(
      parseHelloFruitBtcFiatRates(payload),
      undefined,
      `expected no usable rates from ${JSON.stringify(payload) ?? "undefined"}`,
    );
  }
});

test("the display guard is total; the order-math converter still throws", () => {
  const price = { currency: "USD", value: "2.00" };
  // Exactly what a cast used to let through, one shape per throw the
  // conversion can produce.
  for (const rates of [{ bitcoin: { usd: "unavailable" } }, { bitcoin: { eur: "90000" } }, {}]) {
    assert.deepEqual(toHelloFruitDisplayAmount(price, "SATS", rates), price);
    assert.throws(() => convertHelloFruitUsdAmount(price, "SATS", rates));
  }
  // The guard is a fallback, not a mute button: a usable rate still converts.
  assert.deepEqual(toHelloFruitDisplayAmount(price, "SATS", { bitcoin: { usd: "100000" } }), {
    currency: "SATS",
    value: "2000",
  });
});
