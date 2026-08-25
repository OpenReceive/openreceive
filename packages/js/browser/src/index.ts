// @openreceive/browser — the drop-in browser entry: prepare/create a checkout,
// poll it, and the small DOM helpers around one invoice (QR, copy, wallet).
//
// This file imports from ./internal/** directly, NOT through ./headless.ts.
// The published `/headless` subpath is a curated surface for OpenReceive's own
// UI packages; routing the drop-in entry through it would make every name the
// wrappers need a dependency of the drop-in entry, and hide which of the two
// surfaces a name actually belongs to. The published exports are `.`,
// `/headless`, `/styles.css` and `/assets/*`.

export {
  copyInvoice,
  createCheckoutController,
  // Same `create*` names as ./headless: one function, one name, whichever
  // surface a developer reaches for. These used to be re-exported under short
  // aliases here, so moving between the two entry points meant learning the
  // same helper twice.
  createLightningUri,
  createQrPngDataUrl,
  createQrSvg,
  BrowserRequestError,
  openWallet,
  prepareCheckout,
  requestCheckout,
} from "./internal/checkout.ts";
export {
  createGuestCheckoutResume,
  createGuestOrderFetcher,
  enterCheckoutResumePath,
} from "./internal/guest-resume.ts";
export { createAppBrowserConsoleLogger } from "./internal/console-logger.ts";

export type {
  CheckoutController,
  CheckoutControllerOptions,
  // Deliberately NOT re-exported as `Checkout`: that name is the node
  // package's minted-invoice type; the browser snapshot keeps its own name.
  CheckoutSnapshot,
  CheckoutState,
  CopyInvoiceOptions,
  BrowserLogEntry,
  BrowserLogger,
  BrowserLoggerOption,
  BrowserLogLevel,
  QrOptions,
  OpenWalletOptions,
  PrepareCheckoutOptions,
  RequestCheckoutOptions,
  UnixSeconds,
} from "./internal/ui.ts";
export type {
  GuestCheckoutResumeController,
  GuestCheckoutResumeOptions,
} from "./internal/guest-resume.ts";
export type {
  CreateAppBrowserConsoleLoggerOptions,
  CreateBrowserConsoleLoggerOptions,
  AppBrowserConsoleLogger,
} from "./internal/console-logger.ts";

export { deriveStatus } from "./status.ts";

export type { Status, StatusInvoiceLike } from "./status.ts";
