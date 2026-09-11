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
walkthrough tutorial paths. Those paths are keys into image tables compiled
into the package — browser code is never pointed at remote favicon URLs, and
your host never serves a file. See [Assets](#assets) below.

Node receive servers do not re-host this static catalog. Browser UI packages
import it directly, and server-side apps can import `@openreceive/provider-data`
when they need the same read-only suggestions.

## Assets

Everything the checkout draws ships inside the JavaScript: the payment-method
icons, the wallet logos and the pay tutorials. There is no image file to copy
or serve and no asset option to set. Deploy your normal JavaScript and CSS
build output, including any generated JavaScript chunks. Bundlers with code
splitting can defer tutorial screenshots until first open; single-file builds
(including the standalone checkout) include them upfront. If your
Content-Security-Policy has a strict `img-src`, allow `data:`.

Three tables, one rule:

Registry `icon_path` and tutorial `path` values are lookup keys, never browser
URLs. Use the shipped checkout, or the image lookup APIs below for a custom UI.
Do not copy `src/assets`, configure an asset base URL, or add image-serving routes.

- **Payment-method icons** (Bitcoin, Lightning, USDT, …) are inline SVG
  compiled into `@openreceive/browser` (`paymentIconSvgs`). The custom element
  draws them inline inside its shadow root; `paymentIconUrls` /
  `getPaymentMethodIcon` and friends hand the same markup to any `<img>` as
  `data:image/svg+xml` URIs.
- **Wallet logos** are `data:image/webp;base64,…` URIs in
  `@openreceive/provider-data`'s main bundle: `providerIconUrls` is the table,
  keyed by the registry's `icon_path` (`assets/provider-icons/<id>.webp`), and
  `providerIconUrl(provider)` the lookup. Thirty-seven logos at ≤ 72 px cost
  about 35 KB (47 KB as base64) and load with the JavaScript.
- **Pay tutorials** are the same kind of URI, keyed by each tutorial's `path`,
  in a separate chunk the bundle imports on demand. `loadPayTutorialImages()`
  fetches the chunk once and returns that table (memoised; a rejection means
  "no image"). In a custom UI, use:

  ```ts
  import { loadPayTutorialImages } from "@openreceive/provider-data";

  const images = await loadPayTutorialImages();
  const src = images[tutorial.path]; // data URI for the selected tutorial
  ```

  Render `src` as the image source and update your UI after loading.
  `payTutorialImage(path)` answers from it synchronously — `undefined` until it
  resolves. `WizardProviderTutorialDisplay.image` captures that value when the
  display is created; existing displays do not update after loading. To use
  `tutorial.image`, await the loader and recreate the displays with
  `createWizardRouteDisplays` from `@openreceive/browser/headless` first.
  Twenty screenshots at 800 px tall cost about 201 KB
  (270 KB as base64). Code-splitting builds defer this download until a payer
  opens a tutorial; single-file builds include it in the initial JavaScript.
  The shipped renderers call `loadPayTutorialImages` when a tutorial opens and
  draw the caption alone until it resolves; a custom UI does the same.

Both provider tables are generated from the checked-in source images by
`tools/package/generate-provider-images.mjs` (`npm run
generate:provider-images`; `check:generated` fails when they are stale). It
accepts only `.webp` and enforces byte budgets so the bundle cannot bloat
silently: one logo ≤ 4,096 bytes and all logos ≤ 48 KB; one tutorial ≤ 48 KB
and all tutorials ≤ 240 KB. When a budget fails, the generator prints the
offender and the `cwebp` command that fixes it.

Adding a wallet therefore means adding one ≤ 72 px `.webp` under
`packages/js/provider-data/src/assets/provider-icons/` and naming it as the
entry's `icon_path`; tutorials go under `src/assets/pay_tutorials/`. Encode
them with the recipe the generator documents — downscale only, never upscale:

```sh
cwebp -q 80 -m 6 -af -sharp_yuv -resize 72 0 in.png -o out.webp    # wallet logo
cwebp -q 40 -m 6 -af -sharp_yuv -resize 0 800 in.png -o out.webp   # pay tutorial
```

A test pins that every registry `icon_path` and tutorial `path` has an image
and every image is referenced, so a typo in either direction fails the suite
rather than drawing a blank tile.

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
