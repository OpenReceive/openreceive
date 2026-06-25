# @openreceive/provider-data

Curated, validated, zero-dependency registry of Lightning payment providers and pay-the-invoice route guidance.

## Quick Start

```sh
npm install @openreceive/provider-data
```

```ts
import {
  getPaymentWizardRoutes,
  providerIconUrl
} from "@openreceive/provider-data";

const [route] = getPaymentWizardRoutes({ asset: "eth" });

for (const { provider, flagship } of route.providers) {
  console.log(
    provider.name,
    provider.url,
    providerIconUrl(provider),
    flagship ? "(recommended)" : ""
  );
}
```

`getPaymentWizardRoutes()` returns routes with fully resolved provider objects, so a pay-this-invoice UI can render provider names, URLs, icons, tutorial metadata, and route-specific recommendation flags without making network calls.

The package is frontend-safe: it contains static registry data and bundled provider icon assets only. It does not require a backend, NWC connection, wallet secret, or OpenReceive checkout server.

## Data Only

ESM consumers can import the raw registry JSON:

```ts
import registry from "@openreceive/provider-data/registry.json" with { type: "json" };
```

CommonJS consumers can use `require`:

```js
const registry = require("@openreceive/provider-data/registry.json");
```

## Provider Icons

Provider entries keep repo-local `icon_path` values such as `assets/provider-icons/strike.png`. Use `providerIconUrl(provider)` or `getProviderIconUrl(provider)` to resolve those paths to bundled package asset URLs.

The raw files are also exported under `@openreceive/provider-data/assets/provider-icons/*` for consumers that want to copy or self-host them.

## Provider Tutorials

Some provider entries include ordered walkthrough screenshots under `tutorials`. Use `providerTutorialUrl(tutorial)` or `getProviderTutorialUrl(tutorial)` to resolve paths such as `assets/pay_tutorials/coinbase-1.webp` to bundled package asset URLs.

The raw walkthrough images are also exported under `@openreceive/provider-data/assets/pay_tutorials/*`.
