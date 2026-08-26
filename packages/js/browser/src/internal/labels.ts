// User-facing checkout copy, the compiled stylesheet the element adopts, and
// the attribute coercers that turn raw DOM strings into the typed values
// declared in ./checkout-types.ts.
import { compiledStyles } from "../generated/compiled-styles.ts";
import type {
  PaymentMethod,
  PaymentMethodOption,
  ResolvedTheme,
  ThemePreference,
  ParseOpenReceiveOptionalIntegerOptions,
} from "./checkout-types.ts";

export const checkoutLabels = {
  copyInvoice: "Copy invoice",
  copied: "Copied!",
  openWallet: "Open Wallet",
  bitcoinLightningInvoice: "Bitcoin Lightning invoice",
  paymentStatus: {
    waitingTitle: "Waiting for payment",
    waitingDetail: "Keep this page open while we verify settlement.",
    settledTitle: "Payment received",
    settledDetail: "Backend settlement verified.",
    expiredTitle: "Invoice expired",
    expiredDetail: "Create a fresh invoice to keep going.",
  },
  countdownPrefix: "Invoice expires in",
  startOver: "Start over",
  wizardTitle: "Pay this invoice",
  wizardSubtitle: "Choose how you want to pay.",
  paymentMethod: "Payment method",
  /** Breadcrumb back-link once a method (or swap) is already selected. */
  switchPaymentMethod: "Switch payment method",
  loadingCurrencies: "Loading currencies...",
  emptyBitcoin: "Choose Bitcoin Lightning.",
  openProvider: "How To Pay",
  tutorialTitlePrefix: "Pay a Lightning invoice with",
  tutorialIntroPrefix: "It's easy to make this payment using",
  tutorialIntroCopy: "The first step is to copy the invoice to your clipboard.",
  tutorialCopiedContinue: "Copied! Click next below to continue with tutorial.",
  tutorialExit: "Exit",
  lightningNetwork: "Lightning Network",
  chooseNetwork: "Choose network",
  selectNetwork: "Select network",
  continue: "Continue",
  preparingPayment: "Preparing payment",
  networkSummary: "{asset} will be sent on {network}.",
  chooseAssetNetwork: "Choose {asset} network",
  selectNetworkToContinue: "Select a network to continue",
  transactionDetails: "Transaction details",
  viewOnExplorer: "Explorer",
  decodeInvoice: "Decode",
  /**
   * Deposit heading for a rail whose address does NOT pin the chain, or whose
   * asset is a token an exchange will happily withdraw on the wrong one — the
   * two ways a deposit is actually lost. See `SwapDepositRisk`.
   */
  wrongCurrencyOrNetworkTitle: "Wrong currency or network = lost funds",
  /**
   * Deposit heading for a rail whose address format pins both the chain and the
   * asset (SOL on Solana). Deliberately quiet: an alarm shown on every rail is
   * read on none, and the rails where it is load-bearing — USDT on four
   * networks, ETH on six — are the ones that pay for the erosion.
   */
  sendExactAmountTitle: "Send the exact amount",
  // Payer-facing copy the two renderers (React elements, element HTML) both
  // emit. The dual-renderer architecture is deliberate; duplicated strings are
  // not — the drift it already caused was React's hardcoded "Preparing..." next
  // to the element's `preparingPayment`. tests/wrapper-parity.test.mjs holds the
  // line.
  swapStartFailedTitle: "Could not prepare the payment address",
  tryAgain: "Try again",
  payWithLightningInstead: "Pay with Lightning instead",
  supportReviewNeeded: "This payment needs support review.",
  preparingPaymentAddress: "Preparing payment address",
  preparingPaymentAddressDetail: "Getting your {asset} payment address…",
  createPaymentAddress: "Create {asset} ({network}) payment address",
  paymentBreakdown: "Payment breakdown",
  cartTotal: "Cart total",
  youSend: "You send",
  swapAndNetworkFees: "Swap + network fees",
  refundAddressPlaceholder: "{network} refund address",
  reviewRefundAddress: "Review refund address",
  confirmRefund: "Confirm refund",
  confirmRefundTo: "Confirm refund to {address}.",
  submitting: "Submitting...",
  tutorialBack: "Back",
  tutorialNext: "Next",
  tutorialClose: "Close",
  /**
   * The deposit panel's copy rows. Every value the payer has to REPRODUCE gets a
   * labelled row with a copy button — the amount included, because on token
   * rails the QR carries no amount and the payer types it by hand.
   */
  swapCopyAddress: "Address",
  swapCopyMemo: "Memo",
  swapCopyAmount: "Amount",
  /** Out-of-range swap asset: both renderers build this panel from one model. */
  swapUnavailableTitle: "{asset} unavailable",
  swapUnavailableFallback: "{asset} is not available for this amount.",
  swapUnavailableMinimumOnly: "Minimum {minimum} {asset}.",
  swapUnavailableRange: "Accepted range: {minimum}–{maximum} {asset}.",
  swapUnavailableHint:
    "Choose another asset above, or pay the Lightning invoice at the top of this page.",
  /**
   * One-sentence form of the same limit, for a grid that DISABLES a tile rather
   * than navigating to the four-part pane above — a tooltip or caption has room
   * for a sentence and nowhere to put a title, a detail, a range and a hint.
   * Built by `swapOptionLimitSentence`, from the same figures as
   * `swapOptionLimitMessage`, so the tile and the pane can never quote
   * different numbers.
   */
  swapCartMinimumSentence: "To pay with {asset}, your cart total must be at least {amount}.",
  swapCartMaximumSentence: "To pay with {asset}, your cart total must be at most {amount}.",
  /** Same sentence when the provider only reported PAY-side limits. */
  swapPayMinimumSentence: "To pay with {asset}, the minimum is {amount} {asset}.",
  swapPayMaximumSentence: "To pay with {asset}, the maximum is {amount} {asset}.",
  /** Shown on the refund screen so the payer can return after closing the tab. */
  refundReturnWarning:
    "Bookmark this page, or copy its URL. You need it to return to this refund screen.",
} as const;

export { orClasses } from "../ui-classes.ts";
export { compiledStyles };

export const checkoutElementStyles = `:host{display:block}${compiledStyles}`;

export const paymentMethods: readonly PaymentMethodOption[] = [
  {
    id: "bitcoin",
    title: "Bitcoin",
    detail: "Pay from Lightning or send on-chain into a swap.",
  },
];

export function parseOptionalInteger(
  value: string | null | undefined,
  options: ParseOpenReceiveOptionalIntegerOptions = {},
): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RangeError(`${options.label ?? "value"} must be a non-negative safe integer`);
  }
  return parsed;
}

export function parseBooleanAttribute(value: string | null | undefined): boolean | undefined {
  if (value === null || value === undefined) return undefined;
  return value !== "false";
}

export function parseResolvedTheme(value: string | null | undefined): ResolvedTheme | undefined {
  return value === "light" || value === "dark" ? value : undefined;
}

export function parseThemePreference(
  value: string | null | undefined,
): ThemePreference | undefined {
  return value === "light" || value === "dark" || value === "system" ? value : undefined;
}

export function parsePaymentMethod(value: string | null): PaymentMethod | null {
  return value === "bitcoin" ? value : null;
}
