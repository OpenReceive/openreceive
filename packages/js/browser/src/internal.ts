// @openreceive/browser/internal — the shared floor under OpenReceive's own UI
// packages: @openreceive/elements, @openreceive/react, and (through
// @openreceive/elements/wrapper-shared) the vue/svelte/angular wrappers. It is
// wrapper plumbing, not an integration surface: an application that brings its
// own UI wants ./headless, and a drop-in checkout wants the main entry,
// @openreceive/react, or @openreceive/elements.
//
// Curated symbol-by-symbol, the same way ./headless is, and for the same
// reason: a subpath called "internal" that re-exported the whole package (nine
// `export *` lines) published 290 names — 187 values and 103 types, counted
// off tools/validate/public-api.snapshot.json as it stood before the cut. The
// list below is what is actually imported, and it is well short of that. The
// difference was API by accident, and "is this shared, or is it private?" had
// no answer.
//
// THE RULE: a symbol is promoted here iff something outside
// packages/js/browser imports it BY NAME — one of the UI packages, or a test
// under tests/ that drives an engine seam the UI packages reach only through
// something else — plus the exceptions called out at the bottom of this file.
// Never `export *`. (Counting is a grep, not a figure to maintain: the names
// on this list against the imports in packages/js and tests/.)
//
// Everything not listed is package-private and free to move: the modules
// behind internal/checkout.ts and internal/ui.ts, the wire parsers, the
// log-field builders, the watcher class, and the create-flow steps that only
// createOpenReceiveCheckoutSession calls. Adding a name here is a public-API
// change (tools/validate/public-api.snapshot.json); adding an `export *` is
// not a shortcut, it is the bug this file replaced.

// Custom-element DOM contract: the attribute, part and event names the element
// renders and the wrappers bind to, their derived selectors, and the attribute
// coercers. `docs/internal/wrapper-parity.md` is the human-readable table.
export {
  createCheckoutActionEvent,
  createCheckoutErrorEvent,
  createCheckoutProviderCopyEvent,
  createCheckoutStateEvent,
  createOpenReceiveThemeChangeEvent,
  OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES,
  OPENRECEIVE_CHECKOUT_DATA_SELECTORS,
  OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES,
  OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS,
  OPENRECEIVE_CHECKOUT_ELEMENT_PART_SELECTORS,
  OPENRECEIVE_CHECKOUT_ELEMENT_PARTS,
  OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME,
  OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES,
  OPENRECEIVE_PAYMENT_WIZARD_SELECTORS,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_EVENTS,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_PART_SELECTORS,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_PARTS,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME,
  parseOpenReceiveBooleanAttribute,
  parseOpenReceiveOptionalInteger,
  parseOpenReceivePaymentMethod,
  parseOpenReceiveResolvedTheme,
  parseOpenReceiveThemePreference,
} from "./internal/ui.ts";

// Mounting the element: the attribute/listener factories every wrapper binding
// is built from, the standalone shell, and the theme-toggle element.
export {
  applyCheckoutElementAttributes,
  createCheckoutElementAttributes,
  createCheckoutElementListeners,
  createCheckoutShell,
  createCheckoutShellModel,
  createOpenReceiveThemeToggleElement,
  createOpenReceiveThemeToggleElementAttributes,
} from "./internal/elements.ts";
export type {
  CheckoutElementAttributeOptions,
  CheckoutElementAttributes,
  CheckoutElementEventHandlers,
  CheckoutElementListeners,
  CheckoutShellElements,
  CheckoutShellModel,
  CheckoutShellOptions,
  CreateCheckoutShellOptions,
  OpenReceiveThemeToggleElementAttributeOptions,
  OpenReceiveThemeToggleElementAttributes,
} from "./internal/ui.ts";

// The one declaration of the wrapper prop surface (G7). React and Vue derive
// their props from it; Svelte and Angular restate the names because their prop
// syntax cannot derive, and tests/wrapper-parity.test.mjs polices the gap.
// `validateOpenReceiveCheckoutProps` is the create/snapshot boundary check —
// one implementation, called by the element wrappers and by React alike.
export { validateOpenReceiveCheckoutProps } from "./internal/checkout-props.ts";
export type {
  OpenReceiveCheckoutComponentProps,
  OpenReceiveCheckoutPropsValidation,
} from "./internal/checkout-props.ts";

// Checkout lifecycle: prepare/create calls, the polling controller, and the
// merge rules that fold a freshly minted attempt back into a snapshot without
// losing its siblings.
export {
  createCheckoutController,
  createCheckoutSnapshotFromInvoice,
  prepareCheckout,
  requestCheckout,
} from "./internal/checkout.ts";
export {
  mergeOpenReceiveAttemptIntoCheckout,
  mergeOpenReceiveAttemptIntoSnapshot,
} from "./internal/checkout-merge.ts";
// The create-mode flow itself (G6): the deferred Lightning mint, the swap
// start, and the in-flight guards that make both safe to click twice. One
// implementation, wrapped by the element class and by React's hook.
//
// Its three ingredients — findOpenReceiveReusableLightningInvoice,
// mergeOpenReceiveMintedCheckout and startOpenReceiveSwapRequest — are
// deliberately NOT on this list. Nothing outside packages/js/browser calls
// them; the session is the whole point, and publishing the steps it is made of
// would invite a second, subtly different create flow beside it. (A headless
// integration that does want to drive a swap start itself gets
// startOpenReceiveSwapRequest from ./headless, where it is documented.)
export { createOpenReceiveCheckoutSession } from "./internal/checkout-session.ts";
export type {
  OpenReceiveCheckoutSession,
  OpenReceiveCheckoutSessionOptions,
  OpenReceiveSwapSelection,
} from "./internal/checkout-session.ts";
export { enterCheckoutResumePath } from "./internal/guest-resume.ts";
export type { GuestCheckoutResumeController } from "./internal/guest-resume.ts";
export {
  OPENRECEIVE_DEFAULT_POLL_INTERVAL_MS,
  OPENRECEIVE_DEFAULT_PREFIX,
} from "./internal/ui.ts";
export type {
  CheckoutController,
  CheckoutControllerOptions,
  CheckoutInvoiceSnapshot,
  CheckoutSnapshot,
} from "./internal/ui.ts";

// Checkout state: snapshot + now -> the one derived view both renderers read
// (G4). `assertOpenReceiveDisplayInvoice` is the display boundary — a snapshot
// with no renderable attempt must fail here, loudly, not halfway down a render.
export {
  assertOpenReceiveDisplayInvoice,
  createCheckoutState,
  createCheckoutStatusModel,
  deriveCheckoutStateLabels,
  selectCheckoutDisplayInvoice,
} from "./internal/checkout.ts";
export type {
  CheckoutPhase,
  CheckoutState,
  CheckoutStatusModel,
  CheckoutStatusRefresh,
} from "./internal/ui.ts";
export { status } from "./status.ts";
export type { Status } from "./status.ts";

// Payment wizard: the method grid, network selection, and provider tutorials.
export {
  buildOpenReceiveMethodGridEntries,
  createOpenReceivePaymentWizardController,
  createOpenReceivePaymentWizardModel,
  createOpenReceivePaymentWizardSelection,
  createOpenReceivePaymentWizardState,
  createOpenReceiveWizardRouteAssetDisplays,
  createOpenReceiveWizardRouteDisplays,
  formatOpenReceiveChooseNetworkHeading,
  formatOpenReceiveNetworkSummary,
  getCheckoutProviderIcon,
  getCheckoutProviderOpenLabel,
  getCheckoutProviderTutorials,
  getOpenReceiveNetworkIcon,
  getOpenReceivePaymentMethodIcon,
  getOpenReceivePaymentStatusText,
  getOpenReceiveRouteIcon,
  getOpenReceiveRouteNetworkLabel,
  getOpenReceiveWizardEmptyMessage,
  openReceivePaymentAccentId,
  parseOpenReceiveMethodPickerKey,
  updateOpenReceivePaymentWizardSelection,
} from "./internal/wizard.ts";
export {
  OPENRECEIVE_PROVIDER_PREVIEW_LIMIT,
  openReceivePaymentMethods,
} from "./internal/ui.ts";
export type {
  OpenReceiveCheckoutPaymentMethod,
  OpenReceivePaymentMethod,
  OpenReceivePaymentWizardController,
  OpenReceivePaymentWizardSelection,
  OpenReceiveWizardProviderDisplay,
  OpenReceiveWizardRouteAssetDisplay,
  OpenReceiveWizardRouteDisplay,
} from "./internal/ui.ts";

// Swap flows: asset/network pickers, the deposit view model and its fee
// arithmetic, the refund form, and the swap HTTP calls.
export {
  findOpenReceiveSwapGridGroup,
  getOpenReceiveSwapOptionIcon,
  getOpenReceiveSwapRefundFormError,
  openReceiveSwapGroupLimitOption,
  openReceiveSwapOptionLimitMessage,
  openReceiveSwapPickerKey,
  updateOpenReceiveSelectedSwapNetworks,
} from "./internal/wizard.ts";
export {
  createOpenReceiveSwapDisplayModel,
  getOpenReceiveSwapConfirmationWaitHint,
  openReceiveSwapAssetMatchesRoute,
  overlayOpenReceiveSwapRefundStaging,
} from "./internal/checkout.ts";
export {
  postOpenReceiveJson,
  requestOpenReceiveSwapRefund,
} from "./internal/swap-http.ts";
export type { OpenReceiveSwapDisplayModel } from "./internal/ui.ts";

// Transaction details and payment-data rows: the row model both renderers
// build, plus the explorer/decode links a row can carry.
export {
  createOpenReceiveBlockExplorerUrl,
  createOpenReceiveDetailExternalLink,
  createOpenReceiveLightningInvoiceDecodeUrl,
  createOpenReceivePaymentDataEntries,
  createOpenReceiveTransactionDetails,
  createOpenReceiveTransactionDetailsFromState,
  getOpenReceiveExplorerNetwork,
  resolveOpenReceiveTransactionDetailRows,
} from "./internal/checkout.ts";
export type {
  OpenReceivePaymentDataSource,
  OpenReceiveTransactionDetailsSource,
} from "./internal/checkout.ts";
export type { OpenReceiveTransactionDetailRow } from "./internal/ui.ts";

// Formatting + labels.
//
// THE RULE, restated where the two renderers meet it: FORMATTERS THROW,
// DISPLAY BOUNDARIES BLANK. `formatOpenReceiveMsats` throws a RangeError on an
// amount that is not a non-negative safe integer, because wire construction
// and amount validation share it. `optionalUnixTimeLabel` is the same rule
// with `undefined` in place of the throw: reach for it when the value came
// from a server, so a field a server should never have sent costs one label,
// never the payment screen. (./headless documents this pair at length.)
export {
  escapeOpenReceiveHtml,
  formatOpenReceiveAmountCaption,
  formatOpenReceiveCountdown,
  formatOpenReceiveDepositAmount,
  formatOpenReceiveMsats,
  formatOpenReceiveUnixTime,
  optionalUnixTimeLabel,
} from "./internal/checkout.ts";
export { openReceiveCheckoutLabels } from "./internal/ui.ts";

// Actions and the little controllers around them: QR rendering, copy-to-
// clipboard with its feedback window, open-in-wallet, and the ticking value
// the countdown reads.
export {
  copyInvoice,
  createOpenReceiveTickingValueController,
  createOpenReceiveTransientFeedbackController,
  createQrPayloadSvg,
  createQrSvg,
  openWallet,
} from "./internal/checkout.ts";
export { OPENRECEIVE_COPY_FEEDBACK_MS } from "./internal/ui.ts";
export type {
  OpenReceiveQrEncoder,
  OpenReceiveTransientFeedbackController,
} from "./internal/ui.ts";

// Theme: preference storage, the resolved-theme models the wrappers bind, and
// the control-syncing helpers the element and React both drive.
export {
  applyCheckoutThemeAttributes,
  applyOpenReceiveThemeAttributes,
  createOpenReceiveStoredThemeModel,
  createOpenReceiveThemeModel,
  readOpenReceiveThemePreference,
  resolveOpenReceiveTheme,
  syncOpenReceiveStoredThemeControls,
  toggleOpenReceiveStoredThemeControls,
  toggleOpenReceiveStoredThemePreference,
  writeOpenReceiveThemePreference,
} from "./internal/theme.ts";
export { OPENRECEIVE_THEME_STORAGE_KEY } from "./internal/ui.ts";
export type {
  OpenReceiveResolvedTheme,
  OpenReceiveStoredThemeModelOptions,
  OpenReceiveThemeModel,
  OpenReceiveThemeModelOptions,
  OpenReceiveThemePreference,
} from "./internal/ui.ts";

// Styling tokens: the contract with the shipped stylesheet, so the element's
// HTML strings and React's elements carry the same class names.
export {
  openReceiveCheckoutElementStyles,
  orClasses,
} from "./internal/ui.ts";
export {
  openReceiveAssetButtonClasses,
  openReceiveNetworkButtonClasses,
  openReceiveNetworkCheckClasses,
  openReceiveNetworkMobileRevealClasses,
  openReceiveNetworkSummaryIconClasses,
} from "./internal/wizard.ts";

// Logging: the option a wrapper accepts and the shapes it passes through. The
// console logger itself is on the main entry, not here.
export type {
  OpenReceiveBrowserLogContext,
  OpenReceiveBrowserLogger,
  OpenReceiveBrowserLoggerOption,
} from "./internal/ui.ts";

// THE EXCEPTIONS. Five names that no UI package imports and that do not read
// as wrapper plumbing either — a route builder, a status fetcher, fee
// arithmetic, a wire normalizer, an icon-URL map. Each is pinned by something
// else in the repo, named here so the next reader does not delete one as
// unreachable and does not mistake it for adapter plumbing.
//
//   createOpenReceiveStatusFetcher  — tests/host-payments.test.mjs and
//     tests/browser-checkout-controller.test.mjs poll a real host through it.
//     It is also on ./headless, where integrations should reach for it.
//   openReceiveRoutes — the one route derivation (G5), and the one place the
//     missing-`prefix` guard lives. No wrapper needs it: they all pass
//     `prefix` down and let the engine derive. It is exported so
//     tests/wrapper-parity.test.mjs can pin the documented `/openreceive`
//     default against the routes it actually produces, and so
//     tests/browser-checkout-controller.test.mjs can assert the guard at the
//     boundary every entry point inherits it from.
//   createOpenReceiveSwapFeeBreakdown, normalizeSwapStartInvoice —
//     tests/browser-checkout-controller.test.mjs asserts the fee arithmetic and
//     the start-response normalization directly, below the display model.
//   openReceivePaymentIconUrls — the icon-asset contract's diagnostic.
//     packages/js/browser/README.md tells integrators to log it when icons
//     404, and tools/validate/package-smoke.mjs asserts the packaged URLs
//     resolve into dist/assets/icons.
export {
  createOpenReceiveStatusFetcher,
  createOpenReceiveSwapFeeBreakdown,
  openReceiveRoutes,
} from "./internal/checkout.ts";
export { normalizeSwapStartInvoice } from "./internal/swap-http.ts";
export { openReceivePaymentIconUrls } from "./internal/ui.ts";
