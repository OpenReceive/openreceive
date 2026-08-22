// User-facing checkout copy, the compiled stylesheet the element adopts, and
// the attribute coercers that turn raw DOM strings into the typed values
// declared in ./checkout-types.ts.
import { openReceiveCompiledStyles } from "../generated/compiled-styles.ts";
import type {
  OpenReceivePaymentMethod,
  OpenReceivePaymentMethodOption,
  OpenReceiveResolvedTheme,
  OpenReceiveThemePreference,
  ParseOpenReceiveOptionalIntegerOptions,
} from "./checkout-types.ts";

export const openReceiveCheckoutLabels = {
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
  viewPaymentData: "View payment data",
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
  wrongCurrencyOrNetworkTitle: "Wrong currency or network = lost funds",
  /** Shown on the refund screen so the payer can return after closing the tab. */
  refundReturnWarning:
    "Bookmark this page, or copy its URL. You need it to return to this refund screen.",
} as const;

export { orClasses } from "../ui-classes.ts";
export { openReceiveCompiledStyles };

export const openReceiveCheckoutElementStyles = `:host{display:block}${openReceiveCompiledStyles}`;

export const openReceivePaymentMethods: readonly OpenReceivePaymentMethodOption[] = [
  {
    id: "bitcoin",
    title: "Bitcoin",
    detail: "Pay from Lightning or send on-chain into a swap.",
  },
];

export function parseOpenReceiveOptionalInteger(
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

export function parseOpenReceiveBooleanAttribute(
  value: string | null | undefined,
): boolean | undefined {
  if (value === null || value === undefined) return undefined;
  return value !== "false";
}

export function parseOpenReceiveResolvedTheme(
  value: string | null | undefined,
): OpenReceiveResolvedTheme | undefined {
  return value === "light" || value === "dark" ? value : undefined;
}

export function parseOpenReceiveThemePreference(
  value: string | null | undefined,
): OpenReceiveThemePreference | undefined {
  return value === "light" || value === "dark" || value === "system" ? value : undefined;
}

export function parseOpenReceivePaymentMethod(
  value: string | null,
): OpenReceivePaymentMethod | null {
  return value === "bitcoin" ? value : null;
}
