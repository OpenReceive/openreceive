// Barrel for the browser checkout engine. This file re-exports EXACTLY the
// names @openreceive/browser/internal published before the engine was split by
// concern (G2a) — `../internal.ts` does `export *` from here, so anything added
// to this list becomes public surface. The modules below export more than this
// for each other's use; that stays inside the package.

// ./checkout-ticker.ts — transient feedback + countdown tickers
export {
  createOpenReceiveTickingValueController,
  createOpenReceiveTransientFeedbackController,
} from "./checkout-ticker.ts";
// ./checkout-format.ts — display formatting
export {
  escapeOpenReceiveHtml,
  formatOpenReceiveAmountCaption,
  formatOpenReceiveCountdown,
  formatOpenReceiveDepositAmount,
  formatOpenReceiveFiatAmount,
  formatOpenReceiveInvoiceLabel,
  formatOpenReceiveMsats,
  formatOpenReceivePaymentHashLabel,
  formatOpenReceiveSwapLimit,
  formatOpenReceiveUnixTime,
} from "./checkout-format.ts";
// ./checkout-invoice.ts — bolt11 guards + lightning: URI
export {
  assertOpenReceiveDisplayInvoice,
  createLightningUri,
} from "./checkout-invoice.ts";
// ./checkout-swap-view.ts — the swap attempt as the payer sees it
export {
  createOpenReceiveSwapDisplayModel,
  createOpenReceiveSwapFeeBreakdown,
  getOpenReceiveSwapConfirmationWaitHint,
  openReceiveSwapAssetMatchesRoute,
  overlayOpenReceiveSwapRefundStaging,
} from "./checkout-swap-view.ts";
// ./checkout-links.ts — outbound explorer / decoder links
export type { OpenReceiveExplorerNetwork } from "./checkout-links.ts";
export {
  createOpenReceiveBlockExplorerUrl,
  createOpenReceiveDetailExternalLink,
  createOpenReceiveLightningInvoiceDecodeUrl,
  getOpenReceiveExplorerNetwork,
} from "./checkout-links.ts";
// ./checkout-details.ts — detail rows + payment data entries
export type {
  OpenReceivePaymentDataEntry,
  OpenReceivePaymentDataSource,
} from "./checkout-details.ts";
export {
  createOpenReceivePaymentDataEntries,
  createOpenReceiveTransactionDetails,
  createOpenReceiveTransactionDetailsFromState,
} from "./checkout-details.ts";
// ./checkout-transport.ts — talking to the mounted routes
export {
  createOpenReceiveStatusFetcher,
  OpenReceiveBrowserRequestError,
  prepareCheckout,
  readOpenReceiveJsonResponse,
  requestCheckout,
  resolveOrderUrlFromPrefix,
} from "./checkout-transport.ts";
// ./checkout-state.ts — snapshot -> checkout state
export {
  checkoutInvoiceFromOrderSnapshot,
  createCheckoutDisplayModel,
  createCheckoutSnapshotFromDisplayData,
  createCheckoutState,
  createCheckoutStateFromDisplayData,
  createCheckoutStatusModel,
  isPaidCheckoutSnapshot,
  isReusableLightningInvoice,
  refreshCheckoutState,
  selectCheckoutDisplayInvoice,
  shouldCheckoutShowWaiting,
} from "./checkout-state.ts";
// ./checkout-actions.ts — QR, copy, open wallet
export {
  copyInvoice,
  createQrPayloadSvg,
  createQrPngDataUrl,
  createQrSvg,
  openWallet,
} from "./checkout-actions.ts";
// ./checkout-watcher.ts — polling loop + controller
export {
  CheckoutWatcher,
  createCheckoutController,
  OpenReceiveBrowserCheckoutController,
} from "./checkout-watcher.ts";
