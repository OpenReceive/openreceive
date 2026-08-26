// The asset seam, both halves. `resolveAssetUrl` is a function and cannot cross
// an HTML attribute, so `assetBaseUrl` / `asset-base-url` is the string form —
// the only form plain markup and the Vue/Svelte/Angular wrappers can carry,
// because `defineElements` is first-write-wins and all three call it with no
// options. These tests pin the join rule and both entry points.
import assert from "node:assert/strict";
import test from "node:test";

process.env.LOG_LEVEL ??= "error";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createAssetBaseUrlResolver,
  createCheckoutElementAttributes,
  createWizardRouteAssetDisplays,
  OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES,
  paymentIconPaths,
} from "@openreceive/browser/headless";
import { PaymentWizard } from "@openreceive/react";
import { renderPaymentWizardHtml } from "../packages/js/elements/src/render-wizard.ts";
import { getBitcoinAssets } from "../packages/js/browser/src/internal/wizard.ts";

test("createAssetBaseUrlResolver joins a base to the packaged key", () => {
  const key = "assets/icons/btc.svg";
  // The base is used verbatim apart from its trailing slashes, so a path, a
  // bare root and an absolute origin all produce exactly one separator.
  assert.equal(createAssetBaseUrlResolver("/or-assets")(key), "/or-assets/assets/icons/btc.svg");
  assert.equal(createAssetBaseUrlResolver("/or-assets/")(key), "/or-assets/assets/icons/btc.svg");
  assert.equal(createAssetBaseUrlResolver("/or-assets///")(key), "/or-assets/assets/icons/btc.svg");
  assert.equal(createAssetBaseUrlResolver("/")(key), "/assets/icons/btc.svg");
  assert.equal(createAssetBaseUrlResolver("  /packed  ")(key), "/packed/assets/icons/btc.svg");
  assert.equal(
    createAssetBaseUrlResolver("https://cdn.example.com/or")(key),
    "https://cdn.example.com/or/assets/icons/btc.svg",
  );
  // A caller that hands back a leading-slash key must not produce a double
  // separator either.
  assert.equal(
    createAssetBaseUrlResolver("/or-assets")(`/${key}`),
    "/or-assets/assets/icons/btc.svg",
  );
});

test("the asset base URL rides every element mode as one attribute", () => {
  const name = OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.assetBaseUrl;
  assert.equal(name, "asset-base-url");
  // Shared, not create-mode-only: the wizard and its icons render in all three.
  const create = createCheckoutElementAttributes(null, {
    reference: "order-1",
    assetBaseUrl: "/or-assets",
  });
  assert.equal(create[name], "/or-assets");
  const snapshot = createCheckoutElementAttributes(
    {
      checkout_id: "or_chk_1",
      reference: "order-1",
      status: "open",
      amount_msats: 1000,
      invoices: [],
    },
    { assetBaseUrl: "/or-assets" },
  );
  assert.equal(snapshot[name], "/or-assets");
  // An unbound framework prop arrives as undefined (React) or null
  // (Vue/Svelte/Angular); both must leave the attribute off entirely.
  const unset = createCheckoutElementAttributes(null, { reference: "order-1" });
  assert.equal(unset[name], undefined);
  const nulled = createCheckoutElementAttributes(null, {
    reference: "order-1",
    assetBaseUrl: null,
  });
  assert.equal(nulled[name], undefined);
});

test("the route asset display carries the packaged key next to the resolved URL", () => {
  const [display] = createWizardRouteAssetDisplays(getBitcoinAssets(), {
    resolveAssetUrl: createAssetBaseUrlResolver("/or-assets"),
  });
  assert.equal(display.iconPath, paymentIconPaths.lightning);
  assert.equal(display.icon, `/or-assets/${paymentIconPaths.lightning}`);
});

test("both renderers point their wizard icons at the base URL", () => {
  const resolveAssetUrl = createAssetBaseUrlResolver("/or-assets");

  const html = renderPaymentWizardHtml({
    selectedMethod: null,
    selectedBitcoinRoute: null,
    swapOptions: [],
    resolveAssetUrl,
  });
  assert.match(html, /\/or-assets\/assets\/icons\//);
  assert.doesNotMatch(html, /file:\/\//);

  // React takes the string directly; nothing else about the render changes.
  const react = renderToStaticMarkup(
    React.createElement(PaymentWizard, { assetBaseUrl: "/or-assets" }),
  );
  assert.match(react, /\/or-assets\/assets\/icons\//);
  assert.doesNotMatch(react, /file:\/\//);
});

test("an explicit resolver wins over the base URL", () => {
  const react = renderToStaticMarkup(
    React.createElement(PaymentWizard, {
      assetBaseUrl: "/base-loses",
      resolveAssetUrl: (packagedPath) => `/resolver-wins/${packagedPath}`,
    }),
  );
  assert.match(react, /\/resolver-wins\/assets\/icons\//);
  assert.doesNotMatch(react, /base-loses/);

  // A blank base is "not set", not a base of "" that would strip the leading
  // slash off every packaged key.
  const blank = renderToStaticMarkup(React.createElement(PaymentWizard, { assetBaseUrl: "   " }));
  assert.doesNotMatch(blank, /^\/assets\/icons/m);
});
