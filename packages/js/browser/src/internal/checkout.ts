// Barrel for the browser checkout engine, split by concern in G2a. This list is
// the engine's cross-module surface: what the eleven modules below let each
// other, ../headless.ts and ../index.ts import. It is NOT the published
// surface — both entry points name their exports one by one, so adding a line
// here shares a symbol inside the package without publishing it. The modules
// export more than this for their immediate neighbours; that stays inside the
// package too.

// ./checkout-ticker.ts — transient feedback + countdown tickers
export {
  createTickingValueController,
  createTransientFeedbackController,
} from "./checkout-ticker.ts";
// ./checkout-format.ts — display formatting.
export {
  deriveCheckoutStateLabels,
  escapeHtml,
  formatAmountCaption,
  formatDepositAmount,
  formatFiatAmount,
  formatMsats,
  formatSwapLimit,
  formatUnixTime,
} from "./checkout-format.ts";
// ./checkout-invoice.ts — bolt11 guards + lightning: URI
export {
  assertDisplayInvoice,
  createLightningUri,
} from "./checkout-invoice.ts";
// ./checkout-swap-view.ts — the swap attempt as the payer sees it
export {
  createSwapDisplayModel,
  createSwapFeeBreakdown,
  selectCurrentSwapInvoice,
  swapAssetMatchesRoute,
  swapDepositRisk,
} from "./checkout-swap-view.ts";
// ./checkout-links.ts — outbound explorer / decoder links
export {
  createBlockExplorerUrl,
  createDetailExternalLink,
  createLightningInvoiceDecodeUrl,
  getExplorerNetwork,
} from "./checkout-links.ts";
// ./checkout-details.ts — the transaction-details rows
export type { TransactionDetailsSource } from "./checkout-details.ts";
export {
  createTransactionDetails,
  createTransactionDetailsFromState,
  resolveTransactionDetailRows,
} from "./checkout-details.ts";
// ./checkout-transport.ts — talking to the mounted routes
export {
  createStatusFetcher,
  BrowserRequestError,
  prepareCheckout,
  requestCheckout,
} from "./checkout-transport.ts";
// ./routes.ts — every route derived from the one `prefix` the caller gives.
// The modules that build requests import `Routes` straight from
// there; only the derivation itself is shared through this barrel.
export { checkoutRoutes } from "./routes.ts";
// ./checkout-state.ts — snapshot -> checkout state
export {
  createCheckoutSnapshotFromInvoice,
  createCheckoutState,
  createCheckoutStatusModel,
  isReusableLightningInvoice,
  selectCheckoutDisplayInvoice,
} from "./checkout-state.ts";
// ./checkout-actions.ts — QR, copy, open wallet
export {
  copyInvoice,
  createQrPayloadSvg,
  createQrPngDataUrl,
  createQrSvg,
  createQrSvgController,
  openWallet,
} from "./checkout-actions.ts";
export type { QrSvgController, QrSvgControllerOptions } from "./checkout-actions.ts";
// ./checkout-watcher.ts — polling loop + controller
export { createCheckoutController } from "./checkout-watcher.ts";
