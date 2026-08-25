# Headless checkout

There are two supported ways to build an OpenReceive checkout UI:

1. **Drop-in** — `<Checkout>` from `@openreceive/react` (or the custom elements
   from `@openreceive/elements`, and the vue/svelte/angular wrappers on top of
   them). Start here; see [Frontend checkout](frontend-checkout.md).
2. **Headless** — bring your own components and state management and build on
   the engine directly via `@openreceive/browser/headless`. This is the
   supported, semver-guaranteed surface for custom UIs; the
   `examples/hello-fruit/server/rails` app (custom mobx-keystone stores +
   components over the headless engine) is the flagship demo of this style.

`/headless` is also the floor under OpenReceive's own renderers:
`@openreceive/react`, `@openreceive/elements`, and the vue/svelte/angular
wrappers import exactly this surface and nothing private. What a renderer can
do, a headless integration can do; there is no second, undocumented subpath.
Everything not on the list is package-private and free to move.

## One URL: `prefix`

Every call on this surface that talks to the server takes `prefix` — the base
path the shipped router is mounted at (default `/openreceive`) — and derives its
own route from it: `/checkouts`, `/checkouts/prepare`, `/payments/check`,
`/swaps`, `/swaps/quote`, `/swaps/status`, `/swaps/refunds`. There is no
per-route override, and no URL templating. A headless host holds one string.

```ts
const snapshot = await prepareCheckout({ reference, prefix: "/openreceive" });
const refresh = createStatusFetcher({ prefix: "/openreceive", snapshot });
const started = await startSwapRequest({
  fetch: globalThis.fetch,
  prefix: "/openreceive",
  reference,
  payInAsset: "USDT_TRON",
});
```

## The `@openreceive/browser/headless` surface

Checkout lifecycle:

- `prepareCheckout` / `requestCheckout` — the prepare-then-mint calls (also on
  the main entry). Both take `{ reference, prefix }`. The mint response echoes
  `payment_methods`, so the picker keeps its options on its own; pass the
  prepared snapshot back as `requestCheckout({ previous })` to also keep
  sibling attempts (a live swap beside the new bolt11), and to keep the catalog
  against a server older than contract 0.4.1.
- `createCheckoutState`, `CheckoutState`, `CheckoutSnapshot`,
  `CheckoutInvoiceSnapshot` — engine state and snapshots.
- `selectCheckoutDisplayInvoice`, `isReusableLightningInvoice` — invoice
  display selection.
- `deriveStatus` / `Status`, `createCheckoutStatusModel`, `CheckoutStatusModel`,
  `createStatusFetcher` (`{ prefix, snapshot }`),
  `OPENRECEIVE_DEFAULT_POLL_INTERVAL_MS` — status derivation and polling.
- `postJson`, `BrowserRequestError` — the HTTP helper and
  error type the engine's calls share. It takes `{ fetch, prefix, body }`.

Payment methods and wizard model:

- `paymentMethods`, `PaymentMethod`,
  `CheckoutPaymentMethod`.
- `buildMethodGridEntries` / `MethodGridEntry`,
  `createPaymentWizardModel` / `PaymentWizardModel`,
  `createPaymentWizardSelection` /
  `updatePaymentWizardSelection` /
  `PaymentWizardSelection`,
  `resolvePreservedNetworkSelection`.
- `createWizardRouteDisplays` / `WizardProviderDisplay`,
  `getRouteNetworkLabel`, `paymentAccentId`,
  `SwapMethodGroup`.

Swap flows:

- `startSwapRequest` (`{ fetch, prefix, reference, payInAsset }`),
  `normalizeSwapStartInvoice`.
- `createSwapDisplayModel` / `SwapDisplayModel`,
  `swapAssetMatchesRoute`, `swapPickerKey`,
  `formatSwapLimit`, `formatDepositAmount`.
- `mergeAttemptIntoSnapshot` / `mergeAttemptIntoCheckout` — fold a started
  attempt into the running snapshot, so the deposit becomes the active invoice
  without dropping a still-valid Lightning sibling.

Swap refunds. A deposit that arrives outside the provider's limits, or too
late, becomes refundable, and the payer has to give an address on their own
network. Three symbols, and the third is not optional:

- `requestSwapRefund` — POST the address (`{ fetch, prefix, reference,
  attemptId, refundAddress, confirm }`).
- `getSwapRefundFormError` — the validation message for what the payer typed,
  before you let them submit.
- **`overlaySwapRefundStaging` — REQUIRED IF YOU POLL.** The refund address the
  payer is typing lives in your UI, not on the server, so the next
  `/swaps/status` tick overwrites it and the field empties itself mid-flow.
  Overlay the staged value onto every polled snapshot before you render it.
  This reads like one more helper and is not one.

Rendering the attempt — the pieces a custom UI would otherwise pull a second
library in for:

- `createQrSvg` / `createQrPayloadSvg` — the QR the shipped renderers draw. No
  second QR dependency.
- `openWallet` — hand a `lightning:` URI to the payer's wallet.
- `getNetworkIcon`, `getSwapOptionIcon`, `getPaymentMethodIcon`,
  `paymentIconUrls` — the packaged asset URLs behind the method grid.

Formatting and labels:

- `formatMsats`, `formatFiatAmount`,
  `formatNetworkSummary`, `formatChooseNetworkHeading`.
- `checkoutLabels`, `createLightningInvoiceDecodeUrl`.
- `createTransactionDetails`,
  `createTransactionDetailsFromState`,
  `TransactionDetailRow`, `TransactionDetailsInput`.

Styling tokens (the contract with the shipped `styles.css` — an interface by
nature, so custom UIs reuse the same class names and data attributes):

- `orClasses`, `assetButtonClasses`,
  `networkButtonClasses`, `networkCheckClasses`,
  `networkMobileRevealClasses`,
  `networkSummaryIconClasses`.
- `OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES`, `createCheckoutProviderCopyEvent`.

Element plumbing (tag names, attribute/event constants, element factories)
lives on `@openreceive/elements`, not here: `defineElements`,
`createThemeToggleElement`, `OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME`
/ `_ATTRIBUTES` / `_EVENTS`, and the theme-toggle equivalents.

## Symbol inventory

The sections above say what each group is FOR — that grouping is hand-written,
and it is where a symbol earns an explanation. Completeness is machine-checked
separately: everything on the surface that no section above names appears in
the generated block below, so a promoted symbol cannot sit undocumented and a
dropped one cannot linger. The full sorted inventory, with the same guarantee,
is [docs/internal/headless-surface.md](../internal/headless-surface.md).

<!-- BEGIN GENERATED: headless-symbols-uncovered -->
<!-- Generated by tools/docs/generate-headless-surface.mjs from packages/js/browser/src/headless.ts. Promote or drop the symbol there, then rerun the generator; never edit this block by hand. -->

Also on the surface, in no group above (103 symbols) — element
and theme plumbing, wizard/icon helpers, attribute parsers and log types:

- `applyCheckoutElementAttributes`
- `assertDisplayInvoice`
- `BrowserLogContext`
- `BrowserLogger`
- `BrowserLoggerOption`
- `CheckoutComponentProps`
- `CheckoutController`
- `CheckoutControllerOptions`
- `CheckoutElementAttributeOptions`
- `CheckoutElementAttributes`
- `CheckoutElementEventHandlers`
- `CheckoutElementListeners`
- `checkoutElementStyles`
- `CheckoutPhase`
- `CheckoutPropsValidation`
- `CheckoutSession`
- `CheckoutSessionOptions`
- `CheckoutShellElements`
- `CheckoutShellModel`
- `CheckoutShellOptions`
- `CheckoutStatusRefresh`
- `copyInvoice`
- `createBlockExplorerUrl`
- `createCheckoutActionEvent`
- `createCheckoutController`
- `createCheckoutElementAttributes`
- `createCheckoutElementListeners`
- `createCheckoutErrorEvent`
- `createCheckoutSession`
- `createCheckoutShell`
- `createCheckoutShellModel`
- `CreateCheckoutShellOptions`
- `createCheckoutSnapshotFromInvoice`
- `createCheckoutStateEvent`
- `createDetailExternalLink`
- `createPaymentDataEntries`
- `createPaymentWizardController`
- `createStoredThemeModel`
- `createSwapUnavailableModel`
- `createThemeChangeEvent`
- `createThemeModel`
- `createThemeToggleElementAttributes`
- `createTickingValueController`
- `createTransientFeedbackController`
- `createWizardRouteAssetDisplays`
- `deriveCheckoutStateLabels`
- `DetailLinkKind`
- `enterCheckoutResumePath`
- `escapeHtml`
- `findSwapGridGroup`
- `formatAmountCaption`
- `formatUnixTime`
- `getExplorerNetwork`
- `getWizardEmptyMessage`
- `OPENRECEIVE_CHECKOUT_DATA_SELECTORS`
- `OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES`
- `OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS`
- `OPENRECEIVE_CHECKOUT_ELEMENT_PART_SELECTORS`
- `OPENRECEIVE_CHECKOUT_ELEMENT_PARTS`
- `OPENRECEIVE_COPY_FEEDBACK_MS`
- `OPENRECEIVE_DEFAULT_PREFIX`
- `OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES`
- `OPENRECEIVE_PAYMENT_WIZARD_SELECTORS`
- `OPENRECEIVE_THEME_STORAGE_KEY`
- `OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES`
- `OPENRECEIVE_THEME_TOGGLE_ELEMENT_EVENTS`
- `OPENRECEIVE_THEME_TOGGLE_ELEMENT_PART_SELECTORS`
- `OPENRECEIVE_THEME_TOGGLE_ELEMENT_PARTS`
- `OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME`
- `parseBooleanAttribute`
- `parseMethodPickerKey`
- `parseOptionalInteger`
- `parsePaymentMethod`
- `parseResolvedTheme`
- `parseThemePreference`
- `PaymentDataSource`
- `PaymentWizardController`
- `QrEncoder`
- `readThemePreference`
- `ResolvedTheme`
- `resolveTransactionDetailRows`
- `StoredThemeModelOptions`
- `swapGroupLimitOption`
- `SwapLimitContext`
- `swapOptionLimitMessage`
- `SwapSelection`
- `SwapUnavailableModel`
- `syncStoredThemeControls`
- `ThemeModel`
- `ThemeModelOptions`
- `ThemePreference`
- `ThemeToggleElementAttributeOptions`
- `ThemeToggleElementAttributes`
- `toggleStoredThemeControls`
- `TransactionDetailsSource`
- `TransientFeedbackController`
- `UnixSeconds`
- `updateSelectedSwapNetworks`
- `validateCheckoutProps`
- `wizardNetworkGroupIds`
- `WizardRouteAssetDisplay`
- `WizardRouteDisplay`
- `writeThemePreference`
<!-- END GENERATED: headless-symbols-uncovered -->

## Curation rule

A symbol is on `/headless` if and only if one of OpenReceive's renderers imports it by
name, or a real headless integration (the rails example, these guides) needs
it — never `export *`. The renderers and the flagship example compile against
exactly this surface, so both double as its regression test.

Neither this page nor
[docs/internal/headless-surface.md](../internal/headless-surface.md) can drift
from the entry module: both carry generated blocks, and
`node tools/docs/generate-headless-surface.mjs --check` fails the gate when
either is stale.
