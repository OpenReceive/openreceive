# @openreceive/provider-data

Help customers find a way to pay. This package supplies OpenReceive
checkout with wallet and exchange listings, logos, payment routes, and
step-by-step tutorials. Use the static registry in your own payment UI
without making a network request for each provider.

OpenReceive supports optional swaps from **USDT, USDC, SOL, and ETH** through
a configured swap provider. The provider converts the payment to **BTC over
Lightning**, which settles into the merchant's connected wallet. Available
assets and networks depend on the provider; swaps are optional.

## Quick Start

```sh
npm install @openreceive/provider-data
```

```ts
import {
  getPaymentWizardRoutes,
  providerIconUrl
} from "@openreceive/provider-data";

// No arguments is the checkout's question: btc-lightning, the one route whose
// providers pay a Lightning invoice directly. Name an asset or route to ask for
// another one.
const [route] = getPaymentWizardRoutes();

for (const { provider, rank } of route.providers) {
  console.log(
    provider.name,
    provider.url,
    providerIconUrl(provider),
    rank === undefined ? "" : `(rank ${rank})`
  );
}
```

`getPaymentWizardRoutes()` returns routes with fully resolved provider objects, so a pay-this-invoice UI can render provider names, URLs, icons, tutorial metadata, and per-route provider ordering (`rank`, lower first) without making network calls. Called with no arguments it returns the `btc-lightning` route; `{ asset: "eth" }` or `{ route: "usdt" }` asks for another.

The package is frontend-safe: it contains static registry data and the provider images as data URIs, nothing else. It does not require a backend, NWC connection, wallet secret, or OpenReceive checkout server.

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

Provider entries keep repo-local `icon_path` values such as
`assets/provider-icons/strike.webp`. They are keys, not files:
`providerIconUrls` is a table of `data:image/webp;base64,…` URIs compiled into
this package (37 logos at ≤ 72 px, about 35 KB), and `providerIconUrl(provider)`
looks one up. Nothing to copy or serve, under any bundler or with none.

## Provider Tutorials

Some provider entries include ordered walkthrough screenshots under
`tutorials`, each with a `path` such as `assets/pay_tutorials/coinbase-1.webp`.
Those images are the same kind of data URI, in a separate chunk this package
imports on demand (20 screenshots at 800 px tall, about 201 KB). Call
`loadPayTutorialImages()` when a tutorial opens — it resolves to the whole
table and is memoised — and `payTutorialImage(path)` afterwards for a
synchronous lookup (`undefined` until the chunk is in).

Deploy your bundler's complete JavaScript output, including generated chunks.
Code-splitting builds can defer the screenshot download until first open;
single-file builds (including the standalone checkout) include it upfront.
If your Content-Security-Policy restricts `img-src`, allow `data:`.

Source images live under `src/assets/` as pre-compressed WebP;
`tools/package/generate-provider-images.mjs` renders them into
`src/generated/` under byte budgets, so adding a wallet means adding one
≤ 72 px `.webp`
([Provider registry → Assets](https://github.com/OpenReceive/openreceive/blob/master/docs/guides/provider-registry.md#assets)).
