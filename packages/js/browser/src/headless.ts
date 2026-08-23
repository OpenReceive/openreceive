// @openreceive/browser/headless — the engine under every OpenReceive UI, and
// the supported surface for an application that brings its own. Two kinds of
// consumer, one list:
//
// - OpenReceive's own renderers: @openreceive/elements, @openreceive/react, and
//   (through @openreceive/elements/wrapper-shared) the vue/svelte/angular
//   wrappers build on exactly this — there is no second, private floor.
// - A headless integration (own components, own store, this engine
//   underneath): the hello-fruit rails example is the flagship.
//
// Curated symbol-by-symbol, never `export *`. THE RULE: a symbol is on this
// list iff a renderer in packages/js imports it by name, or a headless
// integration (a demo under examples/, or docs/guides) needs it. A test that
// drives an engine seam imports the source module directly. Adding a name is a
// public-API change (tools/validate/public-api.snapshot.json) and changes the
// generated inventory in docs/guides/headless-checkout.md.
//
// Everything not listed is package-private and free to move: the modules
// behind internal/checkout.ts and internal/ui.ts, the wire parsers, the
// log-field builders, the watcher class, and the create-flow steps that only
// createOpenReceiveCheckoutSession calls.

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
  createOpenReceiveWizardRouteAssetDisplays,
  createOpenReceiveWizardRouteDisplays,
  formatOpenReceiveChooseNetworkHeading,
  formatOpenReceiveNetworkSummary,
  getOpenReceiveNetworkIcon,
  getOpenReceivePaymentMethodIcon,
  getOpenReceiveRouteNetworkLabel,
  getOpenReceiveWizardEmptyMessage,
  openReceivePaymentAccentId,
  parseOpenReceiveMethodPickerKey,
  updateOpenReceivePaymentWizardSelection,
} from "./internal/wizard.ts";
export { openReceivePaymentMethods } from "./internal/ui.ts";
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
  createOpenReceiveStoredThemeModel,
  createOpenReceiveThemeModel,
  readOpenReceiveThemePreference,
  syncOpenReceiveStoredThemeControls,
  toggleOpenReceiveStoredThemeControls,
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

// The icon-asset contract's diagnostic: packages/js/browser/README.md tells
// integrators to log it when icons 404, and tools/validate/package-smoke.mjs
// asserts the packaged URLs resolve into dist/assets/icons.
export { openReceivePaymentIconUrls } from "./internal/ui.ts";

// Headless-integration extras: the pieces an application driving the engine
// from its own store needs beyond what the renderers import — the reusable-
// invoice check, the request error class, the swap start call, and the
// display boundaries (optionalMsatsLabel beside formatOpenReceiveMsats).
export {
  createOpenReceiveStatusFetcher,
  isReusableLightningInvoice,
  OpenReceiveBrowserRequestError,
} from "./internal/checkout.ts";
export { resolveOpenReceivePreservedNetworkSelection } from "./internal/wizard.ts";
export type { OpenReceivePaymentWizardModel } from "./internal/ui.ts";
export type {
  OpenReceiveMethodGridEntry,
  OpenReceiveSwapMethodGroup,
} from "./internal/wizard.ts";
export { formatOpenReceiveSwapLimit } from "./internal/checkout.ts";
export {
  normalizeSwapStartInvoice,
  startOpenReceiveSwapRequest,
} from "./internal/swap-http.ts";
export {
  formatOpenReceiveFiatAmount,
  optionalMsatsLabel,
} from "./internal/checkout.ts";
export type { OpenReceiveTransactionDetailsInput } from "./internal/ui.ts";
