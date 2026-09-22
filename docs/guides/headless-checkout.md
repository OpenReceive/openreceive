# Headless checkout

There are two supported ways to build a checkout UI:

1. **Drop-in**: `<Checkout>` from `@openreceive/react`, or
   `<openreceive-checkout>` from `@openreceive/elements`, plus the
   Vue/Svelte/Angular wrappers. Start here:
   [Frontend checkout](frontend-checkout.md).
2. **Headless**: your own components, built on
   `@openreceive/browser/headless`. This surface is supported and covered by
   semver. The [Buy a Button](https://github.com/OpenReceive/openreceive/tree/master/examples/buttons)
   example is a mobx-keystone store built on this engine.

OpenReceive's own renderers import exactly this surface. Anything they can do,
a headless integration can do too. Everything not listed here is private to the
package.

[Checkout UX](checkout-ux.md) has the rules for what to render. This page is
the API.

## One URL: `prefix`

Every server call takes `prefix`, the path where you mounted the shipped
router. The default is `/openreceive`. Each call adds its own route to it:
`/checkouts`, `/checkouts/prepare`, `/payments/check`, `/swaps`,
`/swaps/quote`, `/swaps/status`, `/swaps/refunds`. You cannot override a
single route.

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

**Start with two objects.** If you skip past them, you will likely end up
rewriting a poll loop.

- `createCheckoutController` / `CheckoutController`: the engine under every
  OpenReceive UI. Give it a snapshot and a `prefix`. It handles:
  - polling
  - sending one request at a time
  - Retry-After backoff
  - the 1 Hz countdown
  - the rules for when to stop
  - the staged refund address

  It reports results through `onSnapshot` / `onState`. Its methods are `start`
  / `stop` / `getState` / `reloadState` / `cancel` / `copyInvoice` /
  `openWallet`, plus the refund pair below. With `polling: false` it stays
  mounted without the poller.
- `createCheckoutSession` / `CheckoutSession`: prepares the checkout, creates
  the invoice, and starts a swap. Its guards make each of those safe to click
  twice.

  For swaps, pass `swap` (`CheckoutSwapOptions`) with `selection`, `prefix`, and
  `fetch` together. Omit `swap` for Lightning-only. `startSwap` then reports
  through `onError`.

Checkout lifecycle:

- `prepareCheckout` / `requestCheckout`: both take `{ reference, prefix }`.
  To keep sibling attempts, pass the prepared snapshot back as
  `requestCheckout({ previous })`.
- `csrfHeader`: accepted by every call above, the controller, and the swap
  calls. It names the header that carries the page's
  `<meta name="csrf-token">` value. The default is `X-CSRF-Token`, which Rails
  and Laravel read. Django reads `X-CSRFToken`. WordPress REST reads
  `X-WP-Nonce`. If your own `headers` sets the same name, your value wins. If
  the page has no meta tag, no header is added.
- `createCheckoutState`, `CheckoutState`, `CheckoutSnapshot`,
  `CheckoutInvoiceSnapshot`.
- `selectCheckoutDisplayInvoice`, `isReusableLightningInvoice`.
- `deriveStatus` / `Status`, `createStatusFetcher` (`{ prefix, snapshot }`),
  `OPENRECEIVE_DEFAULT_POLL_INTERVAL_MS`.
- `createCheckoutStatusModel` / `CheckoutStatusModel`: `{ phase, waiting,
  title, detail, countdownPrefix, expires_in_seconds?, countdownLabel? }`.
  Render `title` and `detail`. Read this model's `phase`, not the snapshot's.
- `postJson`, `BrowserRequestError`: `{ fetch, prefix, body }`.

Payment methods and wizard:

- `paymentMethods`, `PaymentMethod`, `CheckoutPaymentMethod`.
- `buildMethodGridEntries` / `MethodGridEntry`,
  `createMethodGridDisplay` / `MethodGridDisplay` /
  `MethodGridDisplayEntry` / `MethodGridGroupDisplay` /
  `MethodGridContinueDisplay`,
  `resolveWizardSelection` / `WizardSelection`,
  `createPaymentWizardModel` / `PaymentWizardModel`,
  `createPaymentWizardSelection` /
  `updatePaymentWizardSelection` /
  `PaymentWizardSelection`.
- `getPaymentWizardRoutes`,
  `createWizardRouteDisplays` / `WizardProviderDisplay`,
  `getRouteNetworkLabel`, `paymentAccentId`,
  `SwapMethodGroup`.

Swap flows:

- `startSwapRequest` (`{ fetch, prefix, reference, payInAsset }`),
  `normalizeSwapStartInvoice`.
- `createSwapDisplayModel` / `SwapDisplayModel`: the deposit panel as data.
  See [The deposit values are the payer's to reproduce](#the-deposit-values-are-the-payers-to-reproduce).
- `swapAssetMatchesRoute`, `swapPickerKey`,
  `formatSwapLimit`, `formatDepositAmount`.
- `swapDepositRisk` / `SwapDepositRisk`: `"chain_ambiguous" | "asset_only" |
  "pinned"`. The display model already carries this as `depositRisk`.
- `mergeAttemptIntoSnapshot` / `mergeAttemptIntoCheckout`: merge a started
  attempt into the running snapshot. The argument order is
  `(attempt, snapshot)`.

Refunds:

- `SwapRefundStaging`: call `stageSwapRefund({ attemptId, refundAddress })`,
  then `confirmSwapRefund(...)`. Only the second call submits.
  `clearSwapRefundStaging()` goes back to Lightning. See [Refunds](#refunds).
- `getSwapRefundFormError`: validate the address before you submit.
- `resumeSwapAttempt`: after prepare, reopen one attempt by its payment hash.
  `requestSwapStatus` sends the same POST, for when you want to handle the
  `404` yourself.
- `requestSwapRefund`: the low-level POST, for a client with no controller.

Rendering:

- `createQrSvg` / `createQrPayloadSvg`: **both are async**. Use
  `createQrSvgController` / `QrSvgController` so a slow encode cannot paint the
  old QR over the new one. Call `stop()` on teardown.
- `openWallet`: touch devices only. To send the `lightning:` URI somewhere
  other than the current window, pass `open`.
- `getNetworkIcon`, `getSwapOptionIcon`, `getPaymentMethodIcon`: the icon for a
  tile, as a URL. `paymentIconUrls` is the whole table. The payment icons are
  compiled into the package, so these are `data:image/svg+xml` URIs that need
  nothing from your bundler.
- `getNetworkIconId`, `getSwapOptionIconId`, `getPaymentMethodIconId`, and
  `WizardRouteAssetDisplay.iconId`: the `PaymentIconId` behind the URL. Use it
  to draw `paymentIconSvgs[id]` inline, the way the custom element does.
- `loadPayTutorialImages` and `payTutorialImage`: the pay-tutorial screenshots
  load through a dynamic import in `@openreceive/provider-data`. Call
  `loadPayTutorialImages()` when a tutorial opens. It caches its result. If it
  rejects, treat that as "no image". It returns a table keyed by each
  tutorial's `path`:

  ```ts
  import { loadPayTutorialImages } from "@openreceive/browser/headless";

  const images = await loadPayTutorialImages();
  const src = images[tutorial.path]; // data URI for the selected tutorial
  ```

  Use `src` as the image source, and update your UI once loading finishes.
  `WizardProviderTutorialDisplay.image` is a snapshot, not a live lookup.
  Displays created before loading keep their `undefined` image. You have two
  other options:

  - Await the loader, then call `createWizardRouteDisplays` again before
    reading the new `tutorial.image`.
  - Call `payTutorialImage(tutorial.path)`, which reads the loaded cache
    synchronously.

  While loading, or if loading fails, draw the caption alone. Never draw an
  `<img>` with an empty `src`.

  Wallet logos need no call. `WizardProviderDisplay` already carries each one
  as a data URI. Everything the checkout draws ships inside the JavaScript.
  Deploy the complete build output, including JavaScript chunks, and allow
  `data:` in CSP `img-src`. Single-file builds include the screenshots up
  front ([Provider registry](provider-registry.md#assets)).

Formatting and labels:

- `formatMsats`, `formatFiatAmount`,
  `formatNetworkSummary`,
  `createLightningInvoiceDecodeUrl`.
- `checkoutLabels`: every string the shipped renderers show to payers.

  | Label | Value |
  | --- | --- |
  | `copyInvoice` / `copied` | "Copy invoice" / "Copied" |
  | `switchPaymentMethod` | "Switch payment method" |
  | `chooseNetwork` / `selectNetwork` | the network heading and its options |
  | `continue` | the picker's confirm action |
  | `transactionDetails` | the details panel's summary |

The receipt:

- `createTransactionDetails` / `createTransactionDetailsFromState` /
  `resolveTransactionDetailRows`, `TransactionDetailRow`,
  `TransactionDetailsInput`, `TransactionDetailsSource`. See
  [The receipt is not debug output](#the-receipt-is-not-debug-output).

Styling tokens, shared with the shipped `styles.css`:

- `orClasses`, `assetButtonClasses`,
  `networkButtonClasses`, `networkCheckClasses`,
  `networkMobileRevealClasses`,
  `networkSummaryIconClasses`.
- `OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES`, `createCheckoutProviderCopyEvent`.
- `OPENRECEIVE_STYLE_ROOT_ATTRIBUTE` (`data-openreceive-root`): the shipped
  `styles.css` is scoped to this attribute. So put custom markup styled from
  `orClasses` inside a container that carries it, plus the resolved
  `data-theme`. The theme palette starts at that root, not at the page's
  `:root`.

The custom-element helpers live on `@openreceive/elements`, not here:
`defineElements`, `createThemeToggleElement`,
`OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME` / `_ATTRIBUTES` / `_EVENTS`.

## Progress is a status, not a position

Do not draw a Cart → Pay → Done bar. Render
`createCheckoutStatusModel`'s `title` / `detail` / `countdownLabel`, and
read the **model's** `phase`. To let the payer go back, use
`checkoutLabels.switchPaymentMethod`.

When the countdown runs out in the browser, hide the payment instructions and
the countdown. Settlement monitoring keeps going. Hide expired QR codes and
deposit instructions. The controller keeps checking a pending Lightning payment
until the server resolves it. It tracks swap refunds separately, because a
failed or expired wallet payment can still need a provider refund.

- Provider completion never means the order is paid.
- `terminal` means both the payment and the refund tracking are complete, or
  your app cancelled.
- `onSettled` is only a hint for the UI. Never use it to decide fulfillment.

A headless `CheckoutSession` uses `reference()` and `prefix()` as its identity.

- Call `syncIdentity()` when either changes.
- Call `reset()` to start a new session on purpose.
- Call `dispose()` on unmount.

When the identity changes, clear your order-specific selection and refund
draft. The session aborts the requests it can abort. It discards stale
results, errors and loading updates. Theme changes keep the current attempt.
The shipped framework bindings handle this lifecycle for you.

## The method picker, and what to say about a method you cannot offer

- `buildMethodGridEntries` / `createMethodGridDisplay`: tiles, with a
  `limitMessage` taken from the group's cheapest network.
- `SwapLimitContext` is `{ amount_msats, fiat }`, read from the snapshot.
- `swapOptionLimitMessage`: a tile label, such as `"Minimum amount $2.43"`.
- `swapOptionLimitSentence`: a full sentence that names the group
  (`{ label }`).
- `createSwapUnavailableModel` / `SwapUnavailableModel`: the four-part pane
  (`{ title, detail, range, hint }`) shown after the payer picks an asset
  outside its amount range.
- `formatSwapLimit`: the figure alone (`"$2.43"`).

All four use the same figures and rounding. Pick the one that matches the
shape you are rendering.

## Network selection: only ask when it is a real question

`payment_methods` groups by `label`. USDT has several networks. SOL and ETH
have one each. A group with one option has no network question, so start the
swap straight from the tile.

- `resolveWizardSelection({ pickerKey, previousKey, entries, selectedAssetByGroup })`
  returns `start_swap`, `choose_network`, `select_method`, or `none`. A
  single-network group comes back as `start_swap`. The
  `selectedAssetByGroup` map is keyed by group (`USDT`) and valued by
  `pay_in_asset` (`USDT_TRON`).
- `createMethodGridDisplay` carries the same rule per tile as
  `needsNetworkStep` and `startPayInAsset`.

## The deposit values are the payer's to reproduce

On token rails, the deposit QR holds only the address. The payer types the
amount by hand. Give each of these fields its own labelled copy row:

| Field | Row |
| --- | --- |
| `depositAddress` | Address |
| `depositMemo` | Memo. When present, it is part of the address. |
| `depositAmount` | Amount, copied **bare** (no asset symbol) |

`createSwapDisplayModel` already builds `copyRows` this way.

## Refunds

Exactly one provider state allows a refund: `refund_required`. When you
confirm, the server re-reads the live state and may answer `409`. Treat that as
a normal outcome.

A refund takes two steps. Only the second submits:

```ts
await controller.stageSwapRefund({ attemptId: swap.attemptId, refundAddress });
await controller.confirmSwapRefund({ attemptId: swap.attemptId, refundAddress });
```

Validate with `getSwapRefundFormError(payInAsset, address, networkLabel)`
before submit.

`enterCheckoutResumePath` writes the per-order URL into browser history. Tell
the display model whether the payer can come back:

```ts
createSwapDisplayModel(invoice, { resumable: true });
```

and render `display.refundReturnLabel`. The resume helpers
(`createGuestCheckoutResume`, `createGuestOrderFetcher`) are on
`@openreceive/browser`, not `/headless`. See
[What is deliberately not on this surface](#what-is-deliberately-not-on-this-surface)
and [Swap refunds](swap-refunds.md).

| State | Meaning |
| --- | --- |
| `creating_provider_order`, `awaiting_deposit`, `confirming`, `exchanging`, `paying_invoice` | in progress |
| `completed` | the provider is done. This is **not** settlement. |
| `refund_required` → `refund_pending` → `refunded` | the refund path |
| `expired`, `failed`, `attention` | terminal, or needs a human |

`refund_reason` is `underpaid`, `overpaid`, `late_deposit`,
`underpaid_and_late`, or `overpaid_and_late`. An overpayment is refunded like
any other emergency. The whole deposit comes back, never just the surplus.

## The receipt is not debug output

After settlement, the payer has a payment hash. On a swap they also have a
deposit txid. Show them both.

```ts
interface TransactionDetailRow {
  label: string;
  value: string;       // possibly shortened for display
  copyValue?: string;  // the full string — copy this
  href?: string;
  hrefLabel?: string;
}
```

Copy `row.copyValue ?? row.value`. The bolt11 gets a decode link only when
you pass `decodeLinkUrl`. Render the panel collapsed, both on the live checkout
and on the order page.
`@openreceive/react`'s `<TransactionDetails>` mounts the same panel.

## Symbol inventory

The sections above name the symbols a custom UI actually calls. A script
checks that nothing is missing: every export the prose does not name is listed
below. The full sorted list is in
[docs/internal/headless-surface.md](../internal/headless-surface.md).

<!-- BEGIN GENERATED: headless-symbols-uncovered -->
<!-- Generated by tools/docs/generate-headless-surface.mjs from packages/js/browser/src/headless.ts. Promote or drop the symbol there, then rerun the generator; never edit this block by hand. -->

Also on the surface, in no group above (97 symbols) — element
and theme plumbing, wizard/icon helpers, attribute parsers and log types:

- `applyCheckoutElementAttributes`
- `assertDisplayInvoice`
- `BrowserLogContext`
- `BrowserLogger`
- `BrowserLoggerOption`
- `CheckoutComponentProps`
- `CheckoutControllerOptions`
- `CheckoutElementAttributeOptions`
- `CheckoutElementAttributes`
- `CheckoutElementEventHandlers`
- `CheckoutElementListeners`
- `checkoutElementStyles`
- `CheckoutPhase`
- `CheckoutPropsValidation`
- `CheckoutSessionOptions`
- `CheckoutShellElements`
- `CheckoutShellModel`
- `CheckoutShellOptions`
- `CheckoutShellRootAttributes`
- `CheckoutStatusRefresh`
- `createBlockExplorerUrl`
- `createCheckoutActionEvent`
- `createCheckoutElementAttributes`
- `createCheckoutElementListeners`
- `createCheckoutErrorEvent`
- `createCheckoutShell`
- `createCheckoutShellModel`
- `CreateCheckoutShellOptions`
- `createCheckoutSnapshotFromInvoice`
- `createCheckoutStateEvent`
- `createDetailExternalLink`
- `createPaymentWizardController`
- `createStoredThemeModel`
- `createThemeChangeEvent`
- `createThemeModel`
- `createThemeToggleElementAttributes`
- `createTickingValueController`
- `createTransientFeedbackController`
- `createWizardRouteAssetDisplays`
- `currentCheckoutUrl`
- `deriveCheckoutStateLabels`
- `DetailLinkKind`
- `escapeHtml`
- `formatAmountCaption`
- `formatMethodNetworkDetail`
- `formatUnixTime`
- `getExplorerNetwork`
- `getWizardEmptyMessage`
- `OPENRECEIVE_CHECKOUT_DATA_SELECTORS`
- `OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES`
- `OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS`
- `OPENRECEIVE_CHECKOUT_ELEMENT_PART_SELECTORS`
- `OPENRECEIVE_CHECKOUT_ELEMENT_PARTS`
- `OPENRECEIVE_CHECKOUT_ELEMENT_SLOTS`
- `OPENRECEIVE_COPY_FEEDBACK_MS`
- `OPENRECEIVE_DEFAULT_PREFIX`
- `OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES`
- `OPENRECEIVE_PAYMENT_WIZARD_SELECTORS`
- `OPENRECEIVE_PROVIDER_PREVIEW_LIMIT`
- `OPENRECEIVE_STYLE_ROOT_SELECTOR`
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
- `paymentIconSvgs`
- `PaymentWizardController`
- `PaymentWizardRoute`
- `PaymentWizardRouteRequest`
- `QrEncoder`
- `QrSvgControllerOptions`
- `readThemePreference`
- `ResolvedTheme`
- `selectCurrentSwapInvoice`
- `StoredThemeModelOptions`
- `SwapCopyRow`
- `SwapSelection`
- `syncStoredThemeControls`
- `ThemeModel`
- `ThemeModelOptions`
- `ThemePreference`
- `ThemeToggleElementAttributeOptions`
- `ThemeToggleElementAttributes`
- `toggleStoredThemeControls`
- `TransientFeedbackController`
- `UnixSeconds`
- `validateCheckoutProps`
- `WizardRouteAssetDisplay`
- `WizardRouteDisplay`
- `writeThemePreference`
<!-- END GENERATED: headless-symbols-uncovered -->

## What is deliberately not on this surface

`@openreceive/browser` has two entry points. `/headless` is the engine under
a custom UI. The main entry is the drop-in's own surface. They do not
re-export each other.

`createGuestCheckoutResume` and `createGuestOrderFetcher` are the resume
helpers a swap checkout needs for an honest refund form. They live on the main
entry because they depend on your app: your storage and your order fetch.

<!-- BEGIN GENERATED: headless-symbols-main-entry -->
<!-- Generated by tools/docs/generate-headless-surface.mjs by diffing packages/js/browser/src/index.ts against src/headless.ts. Move the symbol between those two entry modules, then rerun the generator; never edit this block by hand. -->

18 names on `@openreceive/browser`
that `/headless` does not carry:

- `AppBrowserConsoleLogger`
- `BrowserLogEntry`
- `BrowserLogLevel`
- `CopyInvoiceOptions`
- `createAppBrowserConsoleLogger`
- `CreateAppBrowserConsoleLoggerOptions`
- `CreateBrowserConsoleLoggerOptions`
- `createGuestCheckoutResume`
- `createGuestOrderFetcher`
- `createLightningUri`
- `createQrPngDataUrl`
- `GuestCheckoutResumeController`
- `GuestCheckoutResumeOptions`
- `OpenWalletOptions`
- `PrepareCheckoutOptions`
- `QrOptions`
- `RequestCheckoutOptions`
- `StatusInvoiceLike`
<!-- END GENERATED: headless-symbols-main-entry -->
