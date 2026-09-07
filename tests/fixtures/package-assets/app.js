import { paymentIconUrls } from "@openreceive/browser/headless";
import { defineElements } from "@openreceive/elements";
import {
  loadPayTutorialImages,
  providerIconUrls,
  providerRegistry,
} from "@openreceive/provider-data";
import { PaymentWizard } from "@openreceive/react";
import React from "react";
import { createRoot } from "react-dom/client";

if (new URLSearchParams(location.search).get("renderer") === "react") {
  document.querySelector("openreceive-checkout").remove();
  createRoot(document.getElementById("react")).render(
    React.createElement(PaymentWizard, { invoice: "lnbc-package-assets" }),
  );
} else {
  defineElements();
}

// Decode the complete published image tables, including wallets outside the
// default route and tutorial steps not reached by the interaction smoke.
window.decodePackagedImages = async () => {
  const tutorials = await loadPayTutorialImages();
  const entries = [
    ...Object.entries(paymentIconUrls),
    ...Object.entries(providerIconUrls),
    ...Object.entries(tutorials),
  ];
  for (const [key, src] of entries) {
    if (!src.startsWith("data:image/")) throw new Error(key + ": not inline");
    const image = new Image();
    image.src = src;
    try {
      await image.decode();
    } catch {
      throw new Error(key + ": cannot decode");
    }
    if (!image.naturalWidth || !image.naturalHeight) throw new Error(key + ": empty");
  }
  for (const provider of Object.values(providerRegistry.providers)) {
    if (!providerIconUrls[provider.icon_path]) throw new Error(provider.id + ": missing logo");
    for (const tutorial of provider.tutorials ?? []) {
      if (!tutorials[tutorial.path]) throw new Error(tutorial.path + ": missing screenshot");
    }
  }
  return {
    icons: Object.keys(paymentIconUrls).length,
    logos: Object.keys(providerIconUrls).length,
    tutorials: Object.keys(tutorials).length,
  };
};
