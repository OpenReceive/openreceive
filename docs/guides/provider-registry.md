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
host has to be able to serve them. See below.

Node receive servers do not re-host this static catalog. Browser UI packages
import it directly, and server-side apps can import `@openreceive/provider-data`
when they need the same read-only suggestions.

## Assets are files your host serves

The icons and pay tutorials are files inside the packages. Vite usually
resolves them. Most other bundlers do not — icons come out blank, and the
built bundle may contain `file://` paths. Grep for `file://` if images are
missing.

Pick one:

1. **Copy the packaged assets next to your bundle.** The demos do this with
   `copy-openreceive-payment-icons-plugin.ts`.
2. **Serve the trees and pass one base URL.** `assetBaseUrl` (React / Vue /
   Svelte / Angular) and `asset-base-url` (the custom element) join every
   packaged path to it. Example: `asset-base-url="/openreceive-assets"` loads
   `/openreceive-assets/assets/icons/btc.svg`. Put
   `node_modules/@openreceive/provider-data/dist/assets` and
   `node_modules/@openreceive/browser/dist/assets` under that root. This is
   the option that works with plain `<openreceive-checkout>` markup.
3. **Map each path yourself.** Display builders take
   `resolveAssetUrl: (packagedPath) => url`.
   `createAssetBaseUrlResolver(base)` from
   `@openreceive/browser/headless` is option 2 as a function.

`@openreceive/browser`'s own payment icons (`assets/icons/*.svg`) use the
same contract, keyed by `paymentIconPaths`.

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
