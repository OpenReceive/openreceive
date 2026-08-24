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
walkthrough tutorial paths, that resolve to local assets bundled by
`@openreceive/provider-data`; they do not point browser code at remote favicon
URLs.

Node receive servers do not re-host this static catalog. Browser UI packages
import it directly, and server-side apps can import `@openreceive/provider-data`
when they need the same read-only suggestions.

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
