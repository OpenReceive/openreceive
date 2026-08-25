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

`icon_path` and the tutorial `path` values name files on disk. The package will
try to resolve each one to a URL for you, and **that resolution only works for a
Vite/Rollup chunk served from `/assets/*.js`.** Under any other bundler it
silently produces something unusable.

The resolution reads `import.meta.url`. Webpack — and anything else that
replaces that expression at build time with the module's own on-disk URL —
turns every entry into:

```
file:///app/node_modules/@openreceive/provider-data/dist/assets/provider-icons/strike.png
```

which is (a) unloadable in a browser and (b) an absolute server path published
in a public asset. The files are not emitted either, and cannot be: webpack's
`new URL(…, import.meta.url)` asset detection requires a string literal, and
both maps build their paths inside a `.map()`, so the bundler never sees an
asset reference to follow. The failure mode is blank images, no request, and no
error.

**If your provider icons or pay tutorials are blank, grep your built bundle for
`file://`.** The packages also log one `console.warn` naming the path the first
time this happens in a document.

Two ways to fix it, and you need one of them under any non-Vite bundler:

1. **Copy the packaged assets next to your bundle.** The demos do this with
   `copy-openreceive-payment-icons-plugin.ts`, which is the reference
   implementation.
2. **Serve the files yourself and tell the UI where they went.** Every display
   builder in `@openreceive/browser/headless`, `PaymentWizard` in
   `@openreceive/react`, and `defineElements` in `@openreceive/elements` take an
   optional `resolveAssetUrl: (packagedPath: string) => string`. It is handed
   the packaged path (`assets/provider-icons/strike.png`) and returns whatever
   URL your host serves it at. The registry's own `icon_path` and tutorial
   `path` strings are the keys, and `WizardProviderDisplay.iconPath` carries the
   key on the display row so you do not have to go back to the registry for it.

`@openreceive/browser`'s own payment icons (`assets/icons/*.svg`) have the same
contract, keyed by `paymentIconPaths`.

## Route Model

Crypto routes start with an asset such as `btc`, `usdt`, or `eth` and resolve to
provider references under `crypto_routes`. The payment wizard offers only the
Bitcoin Lightning method, so `btc-lightning` is the only route it shows — every
provider suggestion the payer sees is a way to pay the Lightning invoice
directly. The registry still carries routes for other assets (swap services and
exchanges that convert the payer's asset into a Lightning payment), but no UI
surfaces them today.
`getPaymentWizardRoutes({ asset })` or `getPaymentWizardRoutes({ route })`
returns the crypto route for any of these assets; the wizard only ever asks for
the Bitcoin route.

Provider entries include conservative availability metadata:

- `us: true` means the registry currently marks the provider as available to US
  users.
- `us: false` means the registry currently marks the provider as unavailable to
  US users.
- `us: null` means the registry does not make a US availability claim.
