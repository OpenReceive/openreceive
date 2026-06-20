# Provider Registry

OpenReceive keeps provider suggestions separate from invoice creation.
The v0.1 scope-lock registry snapshot lives in
`spec/data/providers/openreceive-providers.v2.json`. The JavaScript runtime
package consumes `packages/js/provider-data/src/data/openreceive-providers.v4.json`,
which removes wizard-only summaries, adds repo-local provider icon paths, and
keeps the same route/provider ids for payment-wizard suggestions.

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

The package also exports the master-plan getter names for generated provider
data: `getAssets()`, `getProviders()`, `getCryptoRoutes()`, `getFiatRails()`,
`getCountries()`, `getProvider(id)`, and `getDisqualifiedProviders()`.

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

## Validation

`npm run validate` checks the registry version, counts, provider references,
route references, duplicate route or country ids, duplicate provider refs inside
routes, and contradictory US-availability wording. Package tests check that
helper functions preserve canonical route order and ranked fiat routes.
`validateRegistry()` exposes the embeddable reference checks as `{ valid,
errors }` so applications and generated packages can inspect private registry
copies without terminating the current process.

Provider claims require evidence URLs or conservative caveats. Do not add new
claims by editing package code; update the canonical registry and validation in
the same change.
