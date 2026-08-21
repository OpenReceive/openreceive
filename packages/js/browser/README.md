# @openreceive/browser

Framework-free browser helpers for OpenReceive checkout: prepare/create calls, status polling, QR and wallet helpers.

Part of [OpenReceive](https://openreceive.org). Start with the [Node quickstart](https://github.com/openreceive/openreceive/blob/master/docs/guides/quickstart-node.md); the full API is in the [API reference](https://github.com/openreceive/openreceive/blob/master/docs/guides/api-reference.md).

## Two ways to integrate

- **Drop-in**: use `@openreceive/react` (`<Checkout>`) or `@openreceive/elements`
  (custom elements) for a complete checkout UI; this package's main entry adds
  the small helpers around them (prepare/create calls, `status`, QR, wallet,
  copy).
- **Headless**: build your own UI on the engine via
  `@openreceive/browser/headless` — a curated, semver-guaranteed surface
  (state machine, wizard/status/swap models, formatters, labels, styling
  tokens). See the
  [Headless checkout guide](https://github.com/openreceive/openreceive/blob/master/docs/guides/headless-checkout.md);
  the hello-fruit rails example is the flagship demo of this style.

The `./internal` subpath is wrapper plumbing for OpenReceive's own packages —
unstable, undocumented, and not for end-developer use.

## Icon assets

The checkout UI (used directly or via `@openreceive/react` /
`@openreceive/elements`) loads its payment-method icons from
`dist/assets/icons/*.svg` **by URL at runtime** — the SVGs are not inlined into
the JS. Each URL is resolved with `new URL()` against the module's own
`import.meta.url`:

- module emitted as `…/assets/<chunk>.js` (typical Vite/Rollup output) →
  icons resolve to a sibling `…/assets/icons/*.svg`;
- any other module URL → `./assets/icons/*.svg` next to the module file.

Bundlers do not follow these dynamic URLs, so your app must serve the icon
files where the resolution lands. Per setup:

- **Plain `<script type="module">` / import map**: serve the package's `dist/`
  directory as-is (e.g. `/vendor/openreceive/dist/index.js`). The icons already
  sit at `dist/assets/icons/`, so nothing to copy.
- **Vite / Rollup**: chunks are emitted under `assets/`, so serve the icons at
  `assets/icons/` in the same output — either copy
  `node_modules/@openreceive/browser/dist/assets/icons` into
  `public/assets/icons/`, or copy it into the build output from a small
  `writeBundle` plugin (the repo demos use
  `examples/hello-fruit/shared/copy-openreceive-payment-icons-plugin.ts`).
- **webpack / Next.js**: copy the icons next to your emitted bundles with
  `copy-webpack-plugin` (the repo's Rails Shakapacker demo copies
  `node_modules/@openreceive/browser/dist/assets/icons` to
  `<packs output>/js/assets/icons`). Note webpack can compile `import.meta.url`
  to a build-machine `file://` URL; always confirm the URLs the page actually
  requests (see below) and place — or serve — the icons at that path.

To verify a setup, check the DevTools network panel for `…/icons/*.svg`
requests, or log `openReceivePaymentIconUrls` (exported from
`@openreceive/browser/internal`) to see every resolved URL.

`@openreceive/provider-data` follows the same contract for its runtime images
(`dist/assets/provider-icons`, `dist/assets/pay_tutorials`); the copy recipes
above handle those directories the same way.
