import {
  type CheckoutInvoiceSnapshot,
  type CheckoutState,
  createCheckoutSnapshotFromInvoice,
  createCheckoutState,
  type OpenReceiveBrowserLoggerOption,
  type OpenReceiveCheckoutPaymentMethod,
  type OpenReceivePaymentMethod,
  type OpenReceiveQrEncoder,
  type Status,
} from "@openreceive/browser/internal";

export interface CheckoutView {
  readonly invoice_id?: string;
  readonly invoice: string;
  readonly rail?: "lightning" | "swap" | "checkout_lock";
  readonly payment_hash?: string;
  readonly amount_msats?: number;
  readonly fiat_quote?: {
    readonly fiat?: {
      readonly currency?: string;
      readonly value?: string;
    };
  } | null;
  readonly status?: Status;
  readonly expires_at?: number;
  readonly theme?: "light" | "dark";
  readonly payment_wizard?: boolean;
  /**
   * Base URL of a host-chosen bolt11 decoder, rendered as a "Decode" link.
   * Omitted (the default), no link is rendered and the invoice — amount, payee,
   * description, plus the payer's IP — never reaches a third party.
   */
  readonly decodeLinkUrl?: string;
  /**
   * `false` when the shadow root adopts the compiled stylesheet instead of
   * carrying an inline `<style>` (see element-styles.ts). Default `true` so a
   * standalone caller still gets self-contained markup.
   */
  readonly inlineStyles?: boolean;
  /** False until the payer selects Bitcoin in create-mode (deferred Lightning mint). */
  readonly lightningRequested?: boolean;
  readonly wizard?: OpenReceiveElementsWizardView;
  /**
   * Live controller state, when the element has one. Preferred over the
   * attribute-reconstructed state: after a swap re-key the attributes still
   * describe the pre-swap Lightning attempt (or, in create mode, nothing).
   */
  readonly liveState?: CheckoutState;
}

export interface OpenReceiveElementsWizardView {
  readonly selectedMethod?: OpenReceivePaymentMethod | null;
  readonly selectedBitcoinRoute?: string | null;
  readonly swapOptions?: readonly OpenReceiveElementsSwapOption[];
  /**
   * True until the first order-status response supplies `payment_methods` /
   * `swap_pay_options` (provider catalog warm-up). Shows a loader tile.
   */
  readonly currenciesLoading?: boolean;
  /** Selected pay-in asset per multi-network coin label (e.g. USDT → USDT_TRON). */
  readonly selectedSwapNetworks?: Readonly<Record<string, string>>;
  /** Compact selector highlight: `method:bitcoin` or `swap:USDT`. */
  readonly selectedPickerKey?: string | null;
  /** Pay-in asset whose swap create is in flight — method tiles spin and disable. */
  readonly startingSwapAsset?: string | null;
  /** When set, the wizard shows the focused swap deposit flow for this pay-in asset. */
  readonly selectedSwapAsset?: string | null;
  /** Invoice amount + fiat, used to render fiat limit messages for out-of-range assets. */
  readonly amountMsats?: number;
  readonly fiat?: { readonly currency?: string; readonly value?: string };
  readonly orderId?: string;
  readonly checkoutId?: string;
  /** Display Lightning BOLT11 from the checkout (swap shadows may omit invoice). */
  readonly lightningInvoice?: string;
  /** Host-chosen bolt11 decoder base URL; omitted, the tutorial shows no decode link. */
  readonly decodeLinkUrl?: string;
  readonly paymentHash?: string;
  readonly swapInvoice?: CheckoutInvoiceSnapshot;
  readonly activeTutorialProviderId?: string | null;
  readonly activeTutorialIndex?: number;
  readonly activeTutorialCopied?: boolean;
  /** Swap-start failure rendered inline in the deposit slot with a retry button. */
  readonly swapStartError?: string;
  /** Wizard-level failure (e.g. Lightning mint) rendered inline. */
  readonly wizardError?: string;
}

export type OpenReceiveElementsSwapOption = OpenReceiveCheckoutPaymentMethod;

export interface DefineOpenReceiveElementsOptions {
  readonly tagName?: string;
  readonly themeToggleTagName?: string;
  readonly registry?: CustomElementRegistry;
  readonly qrEncoder?: OpenReceiveQrEncoder;
  readonly logger?: OpenReceiveBrowserLoggerOption;
}

/**
 * The attribute-shaped view as a real checkout state, in the same two hops the
 * element's own snapshot path takes: attempt -> snapshot -> state. Returns
 * undefined in create mode, where no attempt exists yet and the renderer must
 * not show an attempt's status block.
 */
export function createElementCheckoutState(view: CheckoutView): CheckoutState | undefined {
  if (view.invoice_id === undefined) return undefined;
  return createCheckoutState(
    createCheckoutSnapshotFromInvoice({
      invoice_id: view.invoice_id,
      invoice: view.invoice,
      rail: view.rail ?? "lightning",
      ...(view.payment_hash === undefined ? {} : { payment_hash: view.payment_hash }),
      ...(view.amount_msats === undefined ? {} : { amount_msats: view.amount_msats }),
      ...(view.fiat_quote === undefined ? {} : { fiat_quote: view.fiat_quote }),
      ...(view.status === undefined
        ? {}
        : { transaction_state: transactionStateFromStatus(view.status) }),
      ...(view.expires_at === undefined ? {} : { expires_at: view.expires_at }),
    }),
  );
}

export function transactionStateFromStatus(status: Status): string {
  if (status === "settled") return "settled";
  if (status === "expired") return "expired";
  if (status === "failed") return "failed";
  return "pending";
}

export function parseElementStatus(value: string | null): Status | undefined {
  if (value === "pending" || value === "settled" || value === "expired" || value === "failed") {
    return value;
  }
  return undefined;
}
