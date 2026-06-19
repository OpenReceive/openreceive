# Provider Registry

OpenReceive keeps provider suggestions separate from invoice creation.
The canonical provider registry lives in
`spec/data/providers/openreceive-providers.v2.json` and lists services that can
pay a third-party BOLT11 invoice.

The registry is static data. It does not prove that a provider will complete a
payment, quote a particular fee, support a user in a specific jurisdiction, or
stay available. Applications should present provider routes as suggestions and
let the payer choose the third-party service.

## JavaScript Package

`@openreceive/provider-data` wraps the canonical registry with read-only
helpers:

```ts
import {
  listCryptoRouteProviders,
  listFiatProviders,
  listProviders
} from "@openreceive/provider-data";

const btcRoutes = listCryptoRouteProviders("btc-lightning");
const usBankRoutes = listFiatProviders({ rail: "bank", country: "US" });
const usAvailableProviders = listProviders({ us: true });
```

The package does not change provider claims or normalize private copies of the
data. It imports the canonical registry and exposes immutable objects so route
helpers cannot accidentally mutate the source.

## Route Model

Crypto routes start with an asset such as `btc`, `usdt`, or `eth` and resolve to
provider references under `crypto_routes`.

Fiat routes start with a rail such as `bank` or `card`, then a country code such
as `US`, and resolve to ranked provider references under `fiat_rails`.

Provider entries include conservative availability metadata:

- `us: true` means the registry currently marks the provider as available to US
  users.
- `us: false` means the registry currently marks the provider as unavailable to
  US users.
- `us: null` means the registry does not make a US availability claim.

## Validation

`npm run validate` checks the registry version, counts, provider references,
route references, and contradictory US-availability wording. Package tests
check that helper functions preserve canonical route order and ranked fiat
routes.

Provider claims require evidence URLs or conservative caveats. Do not add new
claims by editing package code; update the canonical registry and validation in
the same change.
