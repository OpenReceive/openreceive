// The one rule for images: everything the checkout draws ships inside the
// JavaScript. Payment icons are inline SVG / `data:` URIs compiled into
// @openreceive/browser; wallet logos are `data:image/webp` URIs in
// @openreceive/provider-data's main bundle; pay-tutorial screenshots are the
// same behind one dynamic import, loaded on the first tutorial open. No host
// copies, serves or resolves a file, so there is no resolver, base URL or
// attribute for one — these tests pin that every display model already holds
// a loadable URL, and that the tutorial renders no `<img>` before its chunk
// arrives and a data-URI `<img>` after.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://inline-images.local/" });

process.env.LOG_LEVEL ??= "error";

const assert = (await import("node:assert/strict")).default;
const test = (await import("node:test")).default;
const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");
const { until } = await import("./helpers/lifecycle-harness.mjs");
const {
  createWizardRouteAssetDisplays,
  createWizardRouteDisplays,
  getPaymentWizardRoutes,
  loadPayTutorialImages,
  OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES,
  payTutorialImage,
  paymentIconUrls,
} = await import("@openreceive/browser/headless");
const { providerIconUrls, providerRegistry } = await import("@openreceive/provider-data");
const { PaymentWizard } = await import("@openreceive/react");
const { renderPaymentWizardHtml } = await import("../packages/js/elements/src/render-wizard.ts");
const { getBitcoinAssets } = await import("../packages/js/browser/src/internal/wizard.ts");

const WEBP_PREFIX = "data:image/webp;base64,";
const SVG_PREFIX = "data:image/svg+xml,";

test("every wallet logo is a webp data URI, and every display model icon needs nothing from the host", () => {
  for (const [key, url] of Object.entries(providerIconUrls)) {
    assert.ok(url.startsWith(WEBP_PREFIX), key);
  }
  for (const display of createWizardRouteAssetDisplays(getBitcoinAssets())) {
    assert.equal(display.icon, paymentIconUrls[display.iconId]);
    assert.ok(display.icon.startsWith(SVG_PREFIX), display.id);
    assert.equal("iconPath" in display, false, "no packaged path rides the display any more");
  }
  const [route] = createWizardRouteDisplays(getPaymentWizardRoutes());
  assert.ok(route.providers.length >= 30);
  for (const provider of route.providers) {
    assert.ok(provider.icon.startsWith(WEBP_PREFIX), provider.id);
    assert.equal("iconPath" in provider, false, provider.id);
  }
  // The seam is gone in both of its forms.
  assert.equal(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.assetBaseUrl, undefined);
  assert.equal(
    Object.values(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES).includes("asset-base-url"),
    false,
  );
});

// Both "before load" assertions have to run before anything in this process
// awaits loadPayTutorialImages(): the cache is process-wide by design.
test("the element tutorial renders no <img> before the screenshots load", () => {
  const html = renderPaymentWizardHtml({
    selectedMethod: "bitcoin",
    activeTutorialProviderId: "strike",
    activeTutorialIndex: 2,
  });
  assert.match(html, /part="tutorial-caption"[^>]*>Choose Bitcoin wallet</);
  assert.doesNotMatch(html, /part="tutorial-image"/);
  assert.doesNotMatch(html, /src=""/);
  assert.doesNotMatch(html, /src="undefined"/);
  // The wallet logo in the dialog header is eager, so it is already inline.
  assert.match(html, /part="tutorial-header-logo" alt="" src="data:image\/webp;base64,/);
});

test("the React tutorial renders no <img> before the screenshots load, then a data-URI <img>", async () => {
  const [route] = createWizardRouteDisplays(getPaymentWizardRoutes());
  const strike = route.providers.find((provider) => provider.id === "strike");
  assert.ok(strike);
  for (const tutorial of strike.tutorials) {
    assert.equal(tutorial.image, undefined, `${tutorial.path} is undefined before the load`);
  }

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(PaymentWizard, { invoice: "lnbc1test" }));
  try {
    const open = await until(
      () =>
        [...container.querySelectorAll("button")].find((button) =>
          button.closest("[data-or-provider='strike']"),
        ) ??
        [...container.querySelectorAll("button")].find(
          (button) =>
            button.textContent === "How To Pay" &&
            button.parentElement?.textContent?.includes("Strike"),
        ),
      { label: "Strike's tutorial button" },
    );
    open.click();
    const next = await until(
      () => [...container.querySelectorAll("button")].find((b) => b.textContent === "Next"),
      { label: "tutorial dialog" },
    );
    next.click();
    await until(() => container.textContent?.includes("Step 2 of 5"), { label: "step 2" });
    // The chunk resolves on a later tick; the effect then re-renders with the image.
    const image = await until(() => container.querySelector("img[alt='Tap Send']"), {
      label: "tutorial image",
    });
    assert.ok(image.getAttribute("src")?.startsWith(WEBP_PREFIX));
    assert.equal(container.querySelector("img[src='']"), null);
    assert.equal(container.querySelector("img[src='undefined']"), null);
  } finally {
    root.unmount();
    container.remove();
  }
});

test("loadPayTutorialImages resolves once and payTutorialImage answers every registry tutorial", async () => {
  const first = loadPayTutorialImages();
  assert.equal(loadPayTutorialImages(), first, "memoised: one chunk fetch per page");
  const images = await first;
  let count = 0;
  for (const provider of Object.values(providerRegistry.providers)) {
    for (const tutorial of provider.tutorials ?? []) {
      count += 1;
      const image = payTutorialImage(tutorial.path);
      assert.ok(image?.startsWith(WEBP_PREFIX), tutorial.path);
      assert.equal(images[tutorial.path], image);
    }
  }
  assert.ok(count >= 20);
  assert.equal(payTutorialImage("assets/pay_tutorials/nope.webp"), undefined);

  // After the load every tutorial display carries its image, and the element
  // draws the data-URI <img>.
  const html = renderPaymentWizardHtml({
    selectedMethod: "bitcoin",
    activeTutorialProviderId: "strike",
    activeTutorialIndex: 2,
  });
  assert.match(
    html,
    /<img part="tutorial-image"[^>]*alt="Choose Bitcoin wallet" src="data:image\/webp;base64,/,
  );
  const react = renderToStaticMarkup(React.createElement(PaymentWizard, {}));
  assert.match(react, /src="data:image\/svg\+xml,/);
  assert.doesNotMatch(react, /src=""/);
});
