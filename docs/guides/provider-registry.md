# Provider Registry

A provider is a third-party service the payer may already use — a wallet,
exchange, payments app, or swap service — that can pay an arbitrary BOLT11
Lightning invoice. (It is not the swap provider your server configures through
[Lightning Swap Connect](lightning-swap-connect.md); that one settles funds on
the receiving side, while registry providers are payer-facing suggestions
only.)

OpenReceive keeps provider suggestions separate from invoice creation. Provider
routes help the payer choose a starting point, while the actual payment still
settles to one Lightning invoice created by your server.

The registry is static data. It does not prove that a provider will complete a
payment, quote a particular fee, support a user in a specific jurisdiction, or
stay available. Applications should present provider routes as suggestions and
let the payer choose the third-party service.

## JavaScript Package

`@openreceive/provider-data` wraps the runtime wizard registry with read-only
helpers:

```ts
import {
  getPaymentWizardRoutes,
  listCryptoRouteProviders,
  listProviders,
  validateRegistry
} from "@openreceive/provider-data";

const btcRoutes = listCryptoRouteProviders("btc-lightning");
const usAvailableProviders = listProviders({ us: true });
const btcWizardRoutes = getPaymentWizardRoutes({ asset: "btc" });
const validation = validateRegistry();
```

The package exposes immutable objects so route helpers cannot accidentally
mutate the source. Provider entries include `icon_path` values, and some include
walkthrough tutorial paths. These are **local files shipped inside the package**
— browser code is never pointed at remote favicon URLs — which also means your
host has to be able to serve them. See [Assets](#assets) below.

Node receive servers do not re-host this static catalog. Browser UI packages
import it directly, and server-side apps can import `@openreceive/provider-data`
when they need the same read-only suggestions.

## Assets

Two kinds of image, two rules.

**Payment-method icons** (Bitcoin, Lightning, USDT, …) need nothing from
you. They are compiled into `@openreceive/browser`'s JavaScript: the
drop-in draws them inline inside its shadow root, and `paymentIconUrls` /
`getPaymentMethodIcon` and friends answer `data:image/svg+xml` URIs for any
`<img>` of your own. No file to copy, no loader, no base URL, under any
bundler. The only thing that can get in the way is a Content-Security-Policy
`img-src` that forbids `data:` — and only if you put those URIs in your own
`<img>` (the drop-in's inline SVG is not subject to `img-src`). Allow
`data:` there, or serve files as below.

**Provider icons and pay tutorials** (`@openreceive/provider-data`, PNG and
WebP, about 580 KB) are files your host serves. Vite usually resolves them
from the import. Most other bundlers do not — the images come out blank, and
the built bundle may contain `file://` paths (grep for `file://` if images
are missing; the console also warns once). Pick one:

1. **Serve the tree and pass one base URL.** Copy
   `node_modules/@openreceive/provider-data/dist/assets` to somewhere your
   server serves — say `public/openreceive-assets/assets` — and set
   `assetBaseUrl="/openreceive-assets"` (React / Vue / Svelte / Angular) or
   `asset-base-url="/openreceive-assets"` (the custom element). Every packaged
   path is joined to it: `/openreceive-assets/assets/provider-icons/strike.png`.
   This is the one that works with plain `<openreceive-checkout>` markup, and
   the one to reach for.
2. **Copy the files next to your bundle** so the packaged URLs resolve on
   their own. The demos do this with
   `examples/buttons/shared/copy-openreceive-provider-assets-plugin.ts`
   (Vite) and `copy-webpack-plugin` (the Rails demo).
3. **Map each path yourself.** Display builders take
   `resolveAssetUrl: (packagedPath) => url`.
   `createAssetBaseUrlResolver(base)` from `@openreceive/browser/headless`
   is option 1 as a function.

A base URL or resolver, once set, is honoured for the payment icons too —
they are then served as files from the same root (`assets/icons/<id>.svg`,
keyed by `paymentIconPaths`; `@openreceive/browser/dist/assets` still ships
them). That is the escape hatch for a strict `img-src`; otherwise there is no
reason to copy them.

## Route Model

Crypto routes start with an asset such as `btc`, `usdt`, or `eth` and resolve to
provider references under `crypto_routes`. The payment wizard shows Bitcoin Lightning only.
`getPaymentWizardRoutes()` with no arguments returns that route. Pass
`{ asset }` or `{ route }` only when you deliberately want another list.

Provider entries include conservative availability metadata:

- `us: true` means the registry currently marks the provider as available to US
  users.
- `us: false` means the registry currently marks the provider as unavailable to
  US users.
- `us: null` means the registry does not make a US availability claim.
