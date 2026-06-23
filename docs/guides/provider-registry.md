# Provider Registry

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
  getCountryRoutes,
  getPaymentWizardRoutes,
  listCryptoRouteProviders,
  listFiatProviders,
  listProviders,
  validateRegistry
} from "@openreceive/provider-data";

const btcRoutes = listCryptoRouteProviders("btc-lightning");
const usBankRoutes = listFiatProviders({ rail: "bank", country: "US" });
const usAvailableProviders = listProviders({ us: true });
const usWizardRoutes = getCountryRoutes("US");
const btcWizardRoutes = getPaymentWizardRoutes({ asset: "btc" });
const validation = validateRegistry();
```

The package exposes immutable objects so route helpers cannot accidentally
mutate the source. Provider entries include `icon_path` values that resolve to
local assets bundled by `@openreceive/browser`; they do not point browser code
at remote favicon URLs.

The Express adapter exposes the same static data through display-safe helper
routes at `GET /openreceive/v1/providers` and `GET /openreceive/v1/routes`.

## Route Model

Crypto routes start with an asset such as `btc`, `usdt`, or `eth` and resolve to
provider references under `crypto_routes`.

Fiat routes start with a rail such as `bank` or `card`, then a country code such
as `US`, and resolve to ranked provider references under `fiat_rails`.
`getCountryRoutes(countryCode)` returns every fiat route available for that
country. `getPaymentWizardRoutes({ asset })` returns the crypto route for an
asset, while `getPaymentWizardRoutes({ country, rail })` returns a ranked fiat
route for a payment wizard.

Provider entries include conservative availability metadata:

- `us: true` means the registry currently marks the provider as available to US
  users.
- `us: false` means the registry currently marks the provider as unavailable to
  US users.
- `us: null` means the registry does not make a US availability claim.
