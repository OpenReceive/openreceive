# Provider Registry

A provider is a third-party service the payer may already use that can pay any
BOLT11 Lightning invoice. It might be a wallet, an exchange, a payments app, or
a swap service. It is not the swap provider your server configures through
[Lightning Swap Connect](lightning-swap-connect.md). That one settles funds on
the receiving side. Registry providers are only suggestions shown to the payer.

OpenReceive keeps provider suggestions separate from invoice creation. Provider
routes help the payer pick a place to start. The payment itself still settles
to one Lightning invoice that your server created.

The registry is static data. It does not prove that a provider will complete a
payment, charge a particular fee, serve a user in a given jurisdiction, or stay
available. Present provider routes as suggestions, and let the payer choose the
third-party service.

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

The package returns immutable objects, so route helpers cannot change the
source by accident. Provider entries include `icon_path` values, and some
include walkthrough tutorial paths. Those paths are keys into image tables
compiled into the package. Browser code is never pointed at remote favicon
URLs, and your host never serves a file. See [Assets](#assets) below.

Node receive servers do not host this static catalog again. Browser UI packages
import it directly. Server-side apps can import `@openreceive/provider-data`
when they need the same read-only suggestions.

## Assets

Everything the checkout draws ships inside the JavaScript: the payment-method
icons, the wallet logos and the pay tutorials. There is no image file to copy
or serve, and no asset option to set. Deploy your normal JavaScript and CSS
build output, including any generated JavaScript chunks. Bundlers with code
splitting can wait to load tutorial screenshots until a tutorial is first
opened. Single-file builds, including the standalone checkout, include them up
front. If your Content-Security-Policy has a strict `img-src`, allow `data:`.

There are three tables, and one rule covers all of them.

Registry `icon_path` and tutorial `path` values are lookup keys, never browser
URLs. Use the shipped checkout, or the image lookup APIs below for a custom UI.
Do not copy `src/assets`, configure an asset base URL, or add image-serving
routes.

- **Payment-method icons** (Bitcoin, Lightning, USDT, …) are inline SVG
  compiled into `@openreceive/browser` (`paymentIconSvgs`). The custom element
  draws them inline inside its shadow root. `paymentIconUrls` /
  `getPaymentMethodIcon` and related helpers give the same markup to any
  `<img>` as `data:image/svg+xml` URIs.
- **Wallet logos** are `data:image/webp;base64,…` URIs in
  `@openreceive/provider-data`'s main bundle. `providerIconUrls` is the table,
  keyed by the registry's `icon_path` (`assets/provider-icons/<id>.webp`).
  `providerIconUrl(provider)` looks one up. Thirty-seven logos at ≤ 72 px take
  about 35 KB (47 KB as base64) and load with the JavaScript.
- **Pay tutorials** are the same kind of URI, keyed by each tutorial's `path`.
  They live in a separate chunk that the bundle imports when needed.
  `loadPayTutorialImages()` fetches the chunk once and returns that table. The
  result is memoised, and a rejection means "no image". In a custom UI, use:

  ```ts
  import { loadPayTutorialImages } from "@openreceive/provider-data";

  const images = await loadPayTutorialImages();
  const src = images[tutorial.path]; // data URI for the selected tutorial
  ```

  Render `src` as the image source, and update your UI after loading.
  `payTutorialImage(path)` reads from the same table synchronously. It returns
  `undefined` until the table has loaded. `WizardProviderTutorialDisplay.image`
  captures that value when the display is created, and existing displays do not
  update after loading. To use `tutorial.image`, first await the loader, then
  recreate the displays with `createWizardRouteDisplays` from
  `@openreceive/browser/headless`. Twenty screenshots at 800 px tall take about
  201 KB (270 KB as base64). Code-splitting builds wait to download them until
  a payer opens a tutorial. Single-file builds include them in the initial
  JavaScript. When a tutorial opens, the shipped renderers call
  `loadPayTutorialImages` and show only the caption until it loads. A custom UI
  should do the same.

Both provider tables are generated from the checked-in source images by
`tools/package/generate-provider-images.mjs` (`npm run
generate:provider-images`). `check:generated` fails when they are out of date.
The generator accepts only `.webp`. It enforces byte budgets so the bundle
cannot grow without anyone noticing:

- one logo ≤ 4,096 bytes, and all logos ≤ 48 KB
- one tutorial ≤ 48 KB, and all tutorials ≤ 240 KB

When a budget fails, the generator prints the file that is too large and the
`cwebp` command that fixes it.

To add a wallet, add one ≤ 72 px `.webp` under
`packages/js/provider-data/src/assets/provider-icons/` and name it as the
entry's `icon_path`. Tutorials go under `src/assets/pay_tutorials/`. Encode
them with the recipe the generator documents. Only scale images down, never
up:

```sh
cwebp -q 80 -m 6 -af -sharp_yuv -resize 72 0 in.png -o out.webp    # wallet logo
cwebp -q 40 -m 6 -af -sharp_yuv -resize 0 800 in.png -o out.webp   # pay tutorial
```

A test checks that every registry `icon_path` and tutorial `path` has an image,
and that every image is referenced. So a typo on either side fails the test
suite instead of drawing a blank tile.

## Route Model

Crypto routes start with an asset such as `btc`, `usdt`, or `eth`. They resolve
to provider references under `crypto_routes`. The payment wizard shows only
Bitcoin Lightning. `getPaymentWizardRoutes()` with no arguments returns that
route. Pass `{ asset }` or `{ route }` only when you deliberately want another
list.

Provider entries include cautious availability metadata:

- `us: true` means the registry currently marks the provider as available to US
  users.
- `us: false` means the registry currently marks the provider as unavailable to
  US users.
- `us: null` means the registry makes no claim about US availability.
