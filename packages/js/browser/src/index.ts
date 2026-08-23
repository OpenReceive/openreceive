// @openreceive/browser — the drop-in browser entry: prepare/create a checkout,
// poll it, and the small DOM helpers around one invoice (QR, copy, wallet).
//
// This file imports from ./internal/** directly, NOT from ./internal.ts. The
// ./internal subpath is a curated surface for OpenReceive's own UI packages;
// routing the main entry through it would make every name the wrappers need a
// dependency of the drop-in entry, and hide which of the two surfaces a name
// actually belongs to.

export {
  copyInvoice,
  createCheckoutController,
  createQrPngDataUrl as qrPngDataUrl,
  createQrSvg as qrSvg,
  OpenReceiveBrowserRequestError,
  openWallet,
  prepareCheckout,
  readOpenReceiveJsonResponse,
  requestCheckout,
} from "./internal/checkout.ts";
export { createLightningUri as lightningUri } from "./internal/checkout.ts";
export {
  createGuestCheckoutResume,
  createGuestOrderFetcher,
  enterCheckoutResumePath,
} from "./internal/guest-resume.ts";
export {
  createHostBrowserConsoleLogger,
  createOpenReceiveBrowserConsoleLogger,
  getDefaultOpenReceiveBrowserConsoleLogger,
  openReceiveBrowserLogLevelOrder,
  parseOpenReceiveBrowserLogLevel,
  readOpenReceiveBrowserLogLevelFromEnvironment,
  resolveOpenReceiveBrowserLogLevel,
  resolveOpenReceiveBrowserLogger,
} from "./internal/console-logger.ts";

export type {
  CheckoutController,
  CheckoutControllerOptions,
  // Deliberately NOT re-exported as `Checkout`: that name is the node
  // package's minted-invoice type; the browser snapshot keeps its own name.
  CheckoutSnapshot,
  CheckoutState,
  CopyInvoiceOptions,
  OpenReceiveBrowserLogEntry,
  OpenReceiveBrowserLogger,
  OpenReceiveBrowserLoggerOption,
  OpenReceiveBrowserLogLevel,
  OpenReceiveQrOptions as QrOptions,
  OpenWalletOptions,
  PrepareCheckoutOptions,
  RequestCheckoutOptions,
} from "./internal/ui.ts";
export type {
  GuestCheckoutResumeController,
  GuestCheckoutResumeOptions,
} from "./internal/guest-resume.ts";
export type {
  CreateHostBrowserConsoleLoggerOptions,
  CreateOpenReceiveBrowserConsoleLoggerOptions,
  HostBrowserConsoleLogger,
} from "./internal/console-logger.ts";

export { status } from "./status.ts";

export type { Status, StatusInvoiceLike } from "./status.ts";
