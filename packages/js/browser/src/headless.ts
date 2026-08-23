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
// createCheckoutSession calls.

// Custom-element DOM contract: the attribute, part and event names the element
// renders and the wrappers bind to, their derived selectors, and the attribute
// coercers. `docs/internal/wrapper-parity.md` is the human-readable table.
export {
  createCheckoutActionEvent,
  createCheckoutErrorEvent,
  createCheckoutProviderCopyEvent,
  createCheckoutStateEvent,
  createThemeChangeEvent,
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
  parseBooleanAttribute,
  parseOptionalInteger,
  parsePaymentMethod,
  parseResolvedTheme,
  parseThemePreference,
} from "./internal/ui.ts";

// Mounting the element: the attribute/listener factories every wrapper binding
// is built from, the standalone shell, and the theme-toggle element.
export {
  applyCheckoutElementAttributes,
  createCheckoutElementAttributes,
  createCheckoutElementListeners,
  createCheckoutShell,
  createCheckoutShellModel,
  createThemeToggleElement,
  createThemeToggleElementAttributes,
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
  ThemeToggleElementAttributeOptions,
  ThemeToggleElementAttributes,
} from "./internal/ui.ts";

// The one declaration of the wrapper prop surface (G7). React and Vue derive
// their props from it; Svelte and Angular restate the names because their prop
// syntax cannot derive, and tests/wrapper-parity.test.mjs polices the gap.
// `validateCheckoutProps` is the create/snapshot boundary check —
// one implementation, called by the element wrappers and by React alike.
export { validateCheckoutProps } from "./internal/checkout-props.ts";
export type {
  CheckoutComponentProps,
  CheckoutPropsValidation,
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
  mergeAttemptIntoCheckout,
  mergeAttemptIntoSnapshot,
} from "./internal/checkout-merge.ts";
// The create-mode flow itself (G6): the deferred Lightning mint, the swap
// start, and the in-flight guards that make both safe to click twice. One
// implementation, wrapped by the element class and by React's hook.
//
// Its three ingredients — findReusableLightningInvoice,
// mergeMintedCheckout and startSwapRequest — are
// deliberately NOT on this list. Nothing outside packages/js/browser calls
// them; the session is the whole point, and publishing the steps it is made of
// would invite a second, subtly different create flow beside it. (A headless
// integration that does want to drive a swap start itself gets
// startSwapRequest from ./headless, where it is documented.)
export { createCheckoutSession } from "./internal/checkout-session.ts";
export type {
  CheckoutSession,
  CheckoutSessionOptions,
  SwapSelection,
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
// (G4). `assertDisplayInvoice` is the display boundary — a snapshot
// with no renderable attempt must fail here, loudly, not halfway down a render.
export {
  assertDisplayInvoice,
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
export { deriveStatus } from "./status.ts";
export type { Status } from "./status.ts";

// Payment wizard: the method grid, network selection, and provider tutorials.
export {
  buildMethodGridEntries,
  createPaymentWizardController,
  createPaymentWizardModel,
  createPaymentWizardSelection,
  createWizardRouteAssetDisplays,
  createWizardRouteDisplays,
  formatChooseNetworkHeading,
  formatNetworkSummary,
  getNetworkIcon,
  getPaymentMethodIcon,
  getRouteNetworkLabel,
  getWizardEmptyMessage,
  paymentAccentId,
  parseMethodPickerKey,
  updatePaymentWizardSelection,
} from "./internal/wizard.ts";
export { paymentMethods } from "./internal/ui.ts";
export type {
  CheckoutPaymentMethod,
  PaymentMethod,
  PaymentWizardController,
  PaymentWizardSelection,
  WizardProviderDisplay,
  WizardRouteAssetDisplay,
  WizardRouteDisplay,
} from "./internal/ui.ts";

// Swap flows: asset/network pickers, the deposit view model and its fee
// arithmetic, the refund form, and the swap HTTP calls.
export {
  findSwapGridGroup,
  getSwapOptionIcon,
  getSwapRefundFormError,
  swapGroupLimitOption,
  swapOptionLimitMessage,
  swapPickerKey,
  updateSelectedSwapNetworks,
} from "./internal/wizard.ts";
export {
  createSwapDisplayModel,
  swapAssetMatchesRoute,
  overlaySwapRefundStaging,
} from "./internal/checkout.ts";
export {
  postJson,
  requestSwapRefund,
} from "./internal/swap-http.ts";
export type { SwapDisplayModel } from "./internal/ui.ts";

// Transaction details and payment-data rows: the row model both renderers
// build, plus the explorer/decode links a row can carry.
export {
  createBlockExplorerUrl,
  createDetailExternalLink,
  createLightningInvoiceDecodeUrl,
  createPaymentDataEntries,
  createTransactionDetails,
  createTransactionDetailsFromState,
  getExplorerNetwork,
  resolveTransactionDetailRows,
} from "./internal/checkout.ts";
export type {
  PaymentDataSource,
  TransactionDetailsSource,
} from "./internal/checkout.ts";
export type { TransactionDetailRow } from "./internal/ui.ts";

// Formatting + labels. `formatMsats` throws a RangeError on an amount that is
// not a non-negative safe integer — wire construction, amount validation and
// the display sites share it, and a malformed amount from our own server is a
// bug that must surface. `formatUnixTime` degrades to the raw value instead;
// nothing constructs or validates through it.
export {
  escapeHtml,
  formatAmountCaption,
  formatDepositAmount,
  formatMsats,
  formatUnixTime,
} from "./internal/checkout.ts";
export { checkoutLabels } from "./internal/ui.ts";

// Actions and the little controllers around them: QR rendering, copy-to-
// clipboard with its feedback window, open-in-wallet, and the ticking value
// the countdown reads.
export {
  copyInvoice,
  createTickingValueController,
  createTransientFeedbackController,
  createQrPayloadSvg,
  createQrSvg,
  openWallet,
} from "./internal/checkout.ts";
export { OPENRECEIVE_COPY_FEEDBACK_MS } from "./internal/ui.ts";
export type {
  QrEncoder,
  TransientFeedbackController,
} from "./internal/ui.ts";

// Theme: preference storage, the resolved-theme models the wrappers bind, and
// the control-syncing helpers the element and React both drive.
export {
  createStoredThemeModel,
  createThemeModel,
  readThemePreference,
  syncStoredThemeControls,
  toggleStoredThemeControls,
  writeThemePreference,
} from "./internal/theme.ts";
export { OPENRECEIVE_THEME_STORAGE_KEY } from "./internal/ui.ts";
export type {
  ResolvedTheme,
  StoredThemeModelOptions,
  ThemeModel,
  ThemeModelOptions,
  ThemePreference,
} from "./internal/ui.ts";

// Styling tokens: the contract with the shipped stylesheet, so the element's
// HTML strings and React's elements carry the same class names.
export {
  checkoutElementStyles,
  orClasses,
} from "./internal/ui.ts";
export {
  assetButtonClasses,
  networkButtonClasses,
  networkCheckClasses,
  networkMobileRevealClasses,
  networkSummaryIconClasses,
} from "./internal/wizard.ts";

// Logging: the option a wrapper accepts and the shapes it passes through. The
// console logger itself is on the main entry, not here.
export type {
  BrowserLogContext,
  BrowserLogger,
  BrowserLoggerOption,
} from "./internal/ui.ts";

// The icon-asset contract's diagnostic: packages/js/browser/README.md tells
// integrators to log it when icons 404, and tools/validate/package-smoke.mjs
// asserts the packaged URLs resolve into dist/assets/icons.
export { paymentIconUrls } from "./internal/ui.ts";

// Headless-integration extras: the pieces an application driving the engine
// from its own store needs beyond what the renderers import — the reusable-
// invoice check, the request error class, and the swap start call.
export {
  createStatusFetcher,
  isReusableLightningInvoice,
  BrowserRequestError,
} from "./internal/checkout.ts";
export { resolvePreservedNetworkSelection } from "./internal/wizard.ts";
export type { PaymentWizardModel } from "./internal/ui.ts";
export type {
  MethodGridEntry,
  SwapMethodGroup,
} from "./internal/wizard.ts";
export { formatSwapLimit } from "./internal/checkout.ts";
export {
  normalizeSwapStartInvoice,
  startSwapRequest,
} from "./internal/swap-http.ts";
export { formatFiatAmount } from "./internal/checkout.ts";
export type { TransactionDetailsInput } from "./internal/ui.ts";
