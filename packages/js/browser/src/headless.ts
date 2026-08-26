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
// generated inventory in docs/internal/headless-surface.md.
//
// Everything not listed is package-private and free to move: the modules
// behind internal/checkout.ts and internal/ui.ts, the wire parsers, the
// log-field builders, the watcher class, and the create-flow steps that only
// createCheckoutSession calls.

export type { TransactionDetailsSource } from "./internal/checkout.ts";
// Checkout lifecycle: prepare/create calls, the polling controller, and the
// merge rules that fold a freshly minted attempt back into a snapshot without
// losing its siblings.
// Checkout state: snapshot + now -> the one derived view both renderers read
// (G4). `assertDisplayInvoice` is the display boundary — a snapshot
// with no renderable attempt must fail here, loudly, not halfway down a render.
// Transaction details: the row model both renderers build for the live
// checkout and the receipt, plus the explorer/decode links a row can carry.
// Formatting + labels. `formatMsats` throws a RangeError on an amount that is
// not a non-negative safe integer — wire construction, amount validation and
// the display sites share it, and a malformed amount from our own server is a
// bug that must surface. `formatUnixTime` degrades to the raw value instead;
// nothing constructs or validates through it.
// Actions and the little controllers around them: QR rendering, copy-to-
// clipboard with its feedback window, open-in-wallet, and the ticking value
// the countdown reads.
// Headless-integration extras: the pieces an application driving the engine
// from its own store needs beyond what the renderers import — the reusable-
// invoice check, the request error class, and the swap start call.
export {
  assertDisplayInvoice,
  BrowserRequestError,
  copyInvoice,
  createBlockExplorerUrl,
  createCheckoutController,
  createCheckoutSnapshotFromInvoice,
  createCheckoutState,
  createCheckoutStatusModel,
  createDetailExternalLink,
  createLightningInvoiceDecodeUrl,
  createQrPayloadSvg,
  createQrSvg,
  createStatusFetcher,
  createSwapDisplayModel,
  createTickingValueController,
  createTransactionDetails,
  createTransactionDetailsFromState,
  createTransientFeedbackController,
  deriveCheckoutStateLabels,
  escapeHtml,
  formatAmountCaption,
  formatDepositAmount,
  formatFiatAmount,
  formatMsats,
  formatSwapLimit,
  formatUnixTime,
  getExplorerNetwork,
  isReusableLightningInvoice,
  openWallet,
  prepareCheckout,
  requestCheckout,
  resolveTransactionDetailRows,
  selectCheckoutDisplayInvoice,
  selectCurrentSwapInvoice,
  swapAssetMatchesRoute,
  swapDepositRisk,
} from "./internal/checkout.ts";
export {
  mergeAttemptIntoCheckout,
  mergeAttemptIntoSnapshot,
} from "./internal/checkout-merge.ts";
export type {
  CheckoutComponentProps,
  CheckoutPropsValidation,
} from "./internal/checkout-props.ts";
// The one declaration of the wrapper prop surface (G7). React and Vue derive
// their props from it; Svelte and Angular restate the names because their prop
// syntax cannot derive, and tests/wrapper-parity.test.mjs polices the gap.
// `validateCheckoutProps` is the create/snapshot boundary check —
// one implementation, called by the element wrappers and by React alike.
export { validateCheckoutProps } from "./internal/checkout-props.ts";
export type {
  CheckoutSession,
  CheckoutSessionOptions,
  SwapSelection,
} from "./internal/checkout-session.ts";
// The create-mode flow itself (G6): the deferred Lightning mint, the swap
// start, and the in-flight guards that make both safe to click twice. One
// implementation, wrapped by the element class and by React's hook.
//
// Two of its ingredients — findReusableLightningInvoice and
// mergeMintedCheckout — are deliberately withheld. Nothing outside
// packages/js/browser calls them; the session is the whole point, and
// publishing the reuse and merge steps it is made of would invite a second,
// subtly different create flow beside it. `startSwapRequest` IS published
// below, for a headless integration that drives a swap start itself.
export { createCheckoutSession } from "./internal/checkout-session.ts";
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
// Only `enterCheckoutResumePath` is renderer plumbing: both wrappers call it
// when a create-mode checkout syncs its URL. The guest-resume CONTROLLER is
// host-application behavior (its own storage and order fetch), so its factory
// and its type both live on the main entry — a surface that cannot construct
// the controller has no use for its type.
export { enterCheckoutResumePath } from "./internal/guest-resume.ts";
export {
  normalizeSwapStartInvoice,
  postJson,
  requestSwapRefund,
  startSwapRequest,
} from "./internal/swap-http.ts";
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
// Logging: the option a wrapper accepts and the shapes it passes through. The
// console logger itself is on the main entry, not here.
export type {
  BrowserLogContext,
  BrowserLogger,
  BrowserLoggerOption,
  CheckoutController,
  CheckoutControllerOptions,
  CheckoutElementAttributeOptions,
  CheckoutElementAttributes,
  CheckoutElementEventHandlers,
  CheckoutElementListeners,
  CheckoutInvoiceSnapshot,
  CheckoutPaymentMethod,
  CheckoutPhase,
  CheckoutShellElements,
  CheckoutShellModel,
  CheckoutShellOptions,
  CheckoutSnapshot,
  CheckoutState,
  CheckoutStatusModel,
  CheckoutStatusRefresh,
  CreateCheckoutShellOptions,
  PaymentMethod,
  PaymentWizardController,
  PaymentWizardModel,
  PaymentWizardSelection,
  QrEncoder,
  ResolvedTheme,
  StoredThemeModelOptions,
  SwapCopyRow,
  SwapDepositRisk,
  SwapDisplayModel,
  SwapRefundStaging,
  ThemeModel,
  ThemeModelOptions,
  ThemePreference,
  ThemeToggleElementAttributeOptions,
  ThemeToggleElementAttributes,
  TransactionDetailRow,
  TransactionDetailsInput,
  TransientFeedbackController,
  UnixSeconds,
  WizardProviderDisplay,
  WizardRouteAssetDisplay,
  WizardRouteDisplay,
} from "./internal/ui.ts";
// Custom-element DOM contract: the attribute, part and event names the element
// renders and the wrappers bind to, their derived selectors, and the attribute
// coercers. `docs/internal/wrapper-parity.md` is the human-readable table.
// Styling tokens: the contract with the shipped stylesheet, so the element's
// HTML strings and React's elements carry the same class names.
// The icon-asset contract's diagnostic: packages/js/browser/README.md tells
// integrators to log it when icons 404, and tools/validate/package-smoke.mjs
// asserts the packaged URLs resolve into dist/assets/icons.
export {
  checkoutElementStyles,
  checkoutLabels,
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
  OPENRECEIVE_CHECKOUT_ELEMENT_SLOTS,
  OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME,
  OPENRECEIVE_COPY_FEEDBACK_MS,
  OPENRECEIVE_DEFAULT_POLL_INTERVAL_MS,
  OPENRECEIVE_DEFAULT_PREFIX,
  OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES,
  OPENRECEIVE_PAYMENT_WIZARD_SELECTORS,
  OPENRECEIVE_THEME_STORAGE_KEY,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_EVENTS,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_PART_SELECTORS,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_PARTS,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME,
  orClasses,
  parseBooleanAttribute,
  parseOptionalInteger,
  parsePaymentMethod,
  parseResolvedTheme,
  parseThemePreference,
  paymentIconPaths,
  paymentIconUrls,
  paymentMethods,
} from "./internal/ui.ts";
// The host-side asset seam: packaged icon and tutorial URLs only resolve under
// Vite/Rollup, so every display builder takes one of these and is handed the
// packaged PATH instead. `paymentIconPaths` is the same key set for the icons
// this package owns. `createAssetBaseUrlResolver` is the one-line adapter from
// the string form of the seam (`assetBaseUrl` / `asset-base-url`) to a resolver.
export type { AssetUrlResolver } from "@openreceive/provider-data";
export { createAssetBaseUrlResolver } from "@openreceive/provider-data";
export type {
  MethodGridContinueDisplay,
  MethodGridDisplay,
  MethodGridDisplayEntry,
  MethodGridEntry,
  MethodGridGroupDisplay,
  SwapLimitContext,
  SwapMethodGroup,
  SwapUnavailableModel,
  WizardSelection,
} from "./internal/wizard.ts";
export type { DetailLinkKind } from "./internal/checkout-links.ts";
// Payment wizard: the method grid, network selection, and provider tutorials.
// Swap flows: asset/network pickers, the deposit view model and its fee
// arithmetic, the refund form, and the swap HTTP calls.
export {
  assetButtonClasses,
  buildMethodGridEntries,
  createPaymentWizardController,
  createPaymentWizardModel,
  createMethodGridDisplay,
  createPaymentWizardSelection,
  createSwapUnavailableModel,
  createWizardRouteAssetDisplays,
  createWizardRouteDisplays,
  formatNetworkSummary,
  getNetworkIcon,
  getPaymentMethodIcon,
  getRouteIconPath,
  getRouteNetworkLabel,
  getSwapOptionIcon,
  getSwapRefundFormError,
  getWizardEmptyMessage,
  networkButtonClasses,
  networkCheckClasses,
  networkMobileRevealClasses,
  networkSummaryIconClasses,
  parseMethodPickerKey,
  paymentAccentId,
  resolveWizardSelection,
  swapOptionLimitMessage,
  swapOptionLimitSentence,
  swapPickerKey,
  updatePaymentWizardSelection,
} from "./internal/wizard.ts";
export type { Status } from "./status.ts";
export { deriveStatus } from "./status.ts";
