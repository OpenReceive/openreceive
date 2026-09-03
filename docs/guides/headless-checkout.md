# Headless checkout

Two supported ways to build a checkout UI:

1. **Drop-in** — `<Checkout>` from `@openreceive/react`, or
   `<openreceive-checkout>` from `@openreceive/elements` (and the
   Vue/Svelte/Angular wrappers). Start here:
   [Frontend checkout](frontend-checkout.md).
2. **Headless** — your components, on
   `@openreceive/browser/headless`. This is the supported, semver-guaranteed
   surface. The [Buy a Button](https://github.com/OpenReceive/openreceive/tree/master/examples/buttons)
   example is a mobx-keystone store over this engine.

OpenReceive's own renderers import exactly this surface. What they can do, a
headless integration can do. Everything not listed here is package-private.

The rules for what to render are in [Checkout UX](checkout-ux.md). This page
is the API.

## One URL: `prefix`

Every server call takes `prefix` — the path the shipped router is mounted at
(default `/openreceive`) — and derives its own route:
`/checkouts`, `/checkouts/prepare`, `/payments/check`, `/swaps`,
`/swaps/quote`, `/swaps/status`, `/swaps/refunds`. No per-route override.

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

**Start with two objects.** Reaching past them first is how an integration
ends up rewriting a poll loop.

- `createCheckoutController` / `CheckoutController` — the engine under every
  OpenReceive UI. Hand it a snapshot and a `prefix`. It owns polling,
  one-request-at-a-time, Retry-After backoff, the 1 Hz countdown, stop rules,
  and the staged refund address. Results go out through `onSnapshot` /
  `onState`. Verbs: `start` / `stop` / `getState` / `reloadState` / `cancel`
  / `copyInvoice` / `openWallet`, plus the refund pair below. `polling: false`
  keeps the mount without the poller.
- `createCheckoutSession` / `CheckoutSession` — prepare, mint, and start a
  swap, with the guards that make both safe to click twice.

  For swaps, pass `swap` (`CheckoutSwapOptions`): `selection`, `prefix`, and
  `fetch`, together. Omit `swap` for Lightning-only; `startSwap` then reports
  through `onError`.

Checkout lifecycle:

- `prepareCheckout` / `requestCheckout` — both take `{ reference, prefix }`.
  Pass the prepared snapshot back as `requestCheckout({ previous })` to keep
  sibling attempts.
- `createCheckoutState`, `CheckoutState`, `CheckoutSnapshot`,
  `CheckoutInvoiceSnapshot`.
- `selectCheckoutDisplayInvoice`, `isReusableLightningInvoice`.
- `deriveStatus` / `Status`, `createStatusFetcher` (`{ prefix, snapshot }`),
  `OPENRECEIVE_DEFAULT_POLL_INTERVAL_MS`.
- `createCheckoutStatusModel` / `CheckoutStatusModel` — `{ phase, waiting,
  title, detail, countdownPrefix, expires_in_seconds?, countdownLabel? }`.
  Render `title` and `detail`. Read this model's `phase`, not the snapshot's.
- `postJson`, `BrowserRequestError` — `{ fetch, prefix, body }`.

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
- `createSwapDisplayModel` / `SwapDisplayModel` — the deposit panel as data.
  See [The deposit values are the payer's to reproduce](#the-deposit-values-are-the-payers-to-reproduce).
- `swapAssetMatchesRoute`, `swapPickerKey`,
  `formatSwapLimit`, `formatDepositAmount`.
- `swapDepositRisk` / `SwapDepositRisk` — `"chain_ambiguous" | "asset_only" |
  "pinned"`. The display model already carries this as `depositRisk`.
- `mergeAttemptIntoSnapshot` / `mergeAttemptIntoCheckout` — fold a started
  attempt into the running snapshot. Argument order is `(attempt, snapshot)`.

Refunds:

- `SwapRefundStaging` — `stageSwapRefund({ attemptId, refundAddress })` then
  `confirmSwapRefund(...)`. Only the second submits.
  `clearSwapRefundStaging()` exits back to Lightning. See [Refunds](#refunds).
- `getSwapRefundFormError` — validate the address before submit.
- `resumeSwapAttempt` — reopen one attempt by payment hash after prepare.
  `requestSwapStatus` is the same POST when you want the `404` yourself.
- `requestSwapRefund` — the low-level POST, for a client with no controller.

Rendering:

- `createQrSvg` / `createQrPayloadSvg` — **both are async**. Use
  `createQrSvgController` / `QrSvgController` so a late encode cannot paint
  the old QR over the new one. `stop()` on teardown.
- `openWallet` — touch devices only. Pass `open` to send the `lightning:`
  URI somewhere other than the current window.
- `getNetworkIcon`, `getSwapOptionIcon`, `getPaymentMethodIcon` — the icon
  for a tile as a URL; `paymentIconUrls` is the whole table. The payment
  icons are compiled into the package, so these are `data:image/svg+xml`
  URIs that need nothing from your bundler (allow `data:` in your CSP
  `img-src`, or pass a resolver to serve files instead).
- `getNetworkIconId`, `getSwapOptionIconId`, `getPaymentMethodIconId`, and
  `WizardRouteAssetDisplay.iconId` — the `PaymentIconId` behind the URL, for
  drawing `paymentIconSvgs[id]` inline the way the custom element does.
- `AssetUrlResolver` and `paymentIconPaths` — map packaged paths to URLs
  you serve. Provider images need this; payment icons only if you choose
  files over `data:`. See [Provider registry](provider-registry.md#assets).
- `createAssetBaseUrlResolver` — the same seam as one string. This is what
  `assetBaseUrl` / `asset-base-url` are built on.

Formatting and labels:

- `formatMsats`, `formatFiatAmount`,
  `formatNetworkSummary`,
  `createLightningInvoiceDecodeUrl`.
- `checkoutLabels` — every payer-facing string the shipped renderers emit.

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
  `TransactionDetailsInput`, `TransactionDetailsSource` — see
  [The receipt is not debug output](#the-receipt-is-not-debug-output).

Styling tokens (shared with the shipped `styles.css`):

- `orClasses`, `assetButtonClasses`,
  `networkButtonClasses`, `networkCheckClasses`,
  `networkMobileRevealClasses`,
  `networkSummaryIconClasses`.
- `OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES`, `createCheckoutProviderCopyEvent`.
- `OPENRECEIVE_STYLE_ROOT_ATTRIBUTE` (`data-openreceive-root`): the shipped
  `styles.css` is scoped to it, so custom markup styled from `orClasses` sits
  under a container that carries it plus the resolved `data-theme` — the theme
  palette starts at that root, not at the page's `:root`.

Element plumbing lives on `@openreceive/elements`, not here:
`defineElements`, `createThemeToggleElement`,
`OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME` / `_ATTRIBUTES` / `_EVENTS`.

## Progress is a status, not a position

Do not draw a Cart → Pay → Done bar. Render
`createCheckoutStatusModel`'s `title` / `detail` / `countdownLabel`, and
read the **model's** `phase`. Carry backwards movement with
`checkoutLabels.switchPaymentMethod`.

## The method picker, and what to say about a method you cannot offer

- `buildMethodGridEntries` / `createMethodGridDisplay` — tiles, with
  `limitMessage` quoted from the group's cheapest network.
- `SwapLimitContext` is `{ amount_msats, fiat }` off the snapshot.
- `swapOptionLimitMessage` — tile label: `"Minimum amount $2.43"`.
- `swapOptionLimitSentence` — finished sentence, named by group (`{ label }`).
- `createSwapUnavailableModel` / `SwapUnavailableModel` — the four-part pane
  (`{ title, detail, range, hint }`) after the payer picks an out-of-range
  asset.
- `formatSwapLimit` — the figure alone (`"$2.43"`).

All four use the same figures and rounding. Pick the one that matches the
shape you are rendering.

## Network selection: only ask when it is a real question

`payment_methods` groups by `label`. USDT has several networks; SOL and ETH
have one. A group with one option has no network question: start the swap
from the tile.

- `resolveWizardSelection({ pickerKey, previousKey, entries, selectedAssetByGroup })`
  returns `start_swap`, `choose_network`, `select_method`, or `none`. A
  single-network group comes back as `start_swap`. The
  `selectedAssetByGroup` map is keyed by group (`USDT`) and valued by
  `pay_in_asset` (`USDT_TRON`).
- `createMethodGridDisplay` carries the same rule per tile as
  `needsNetworkStep` and `startPayInAsset`.

## The deposit values are the payer's to reproduce

On token rails the deposit QR is the address only. The payer types the
amount by hand. Give each of these a labelled copy row:

| Field | Row |
| --- | --- |
| `depositAddress` | Address |
| `depositMemo` | Memo — when present it is part of the address |
| `depositAmount` | Amount, copied **bare** (no asset symbol) |

`createSwapDisplayModel` already builds `copyRows` this way.

## Refunds

Exactly one provider state allows a refund: `refund_required`. The server
re-reads live state at confirm time and may answer `409`. Handle that as a
normal outcome.

Two steps. Only the second submits:

```ts
await controller.stageSwapRefund({ attemptId: swap.attemptId, refundAddress });
await controller.confirmSwapRefund({ attemptId: swap.attemptId, refundAddress });
```

Validate with `getSwapRefundFormError(payInAsset, address, networkLabel)`
before submit.

`enterCheckoutResumePath` writes the per-order URL into history. Tell the
display model whether the payer can come back:

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
| `completed` | the provider is done — **not** settlement |
| `refund_required` → `refund_pending` → `refunded` | the refund path |
| `expired`, `failed`, `attention` | terminal, or needs a human |

`refund_reason` is `underpaid`, `overpaid`, `late_deposit`,
`underpaid_and_late`, or `overpaid_and_late`. An overpayment is a refund like
any other emergency: the whole deposit comes back, never the surplus alone.

## The receipt is not debug output

After settlement the payer holds a payment hash and, on a swap, a deposit
txid. Show them.

```ts
interface TransactionDetailRow {
  label: string;
  value: string;       // possibly shortened for display
  copyValue?: string;  // the full string — copy this
  href?: string;
  hrefLabel?: string;
}
```

Wire copy to `row.copyValue ?? row.value`. The bolt11 gets a decode link
only when you pass `decodeLinkUrl`. Render the panel collapsed, on the live
checkout and on the order page.
`@openreceive/react`'s `<TransactionDetails>` mounts the same panel.

## Symbol inventory

The sections above name the symbols a custom UI actually calls. Completeness
is machine-checked: every export the prose does not name appears below. The
full sorted list is
[docs/internal/headless-surface.md](../internal/headless-surface.md).

<!-- BEGIN GENERATED: headless-symbols-uncovered -->
<!-- Generated by tools/docs/generate-headless-surface.mjs from packages/js/browser/src/headless.ts. Promote or drop the symbol there, then rerun the generator; never edit this block by hand. -->

Also on the surface, in no group above (98 symbols) — element
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
- `getRouteIconPath`
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

`createGuestCheckoutResume` and `createGuestOrderFetcher` — the resume
helpers a swap checkout needs for a honest refund form — live on the main
entry, because they are host behaviour (your storage, your order fetch).

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
