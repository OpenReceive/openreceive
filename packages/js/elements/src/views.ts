import {
  type CheckoutInvoiceSnapshot,
  type CheckoutState,
  createCheckoutSnapshotFromInvoice,
  createCheckoutState,
  type BrowserLoggerOption,
  type CheckoutPaymentMethod,
  type PaymentMethod,
  type QrEncoder,
  type Status,
} from "@openreceive/browser/headless";

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
  readonly wizard?: ElementsWizardView;
  /**
   * Live controller state, when the element has one. Preferred over the
   * attribute-reconstructed state: after a swap re-key the attributes still
   * describe the pre-swap Lightning attempt (or, in create mode, nothing).
   */
  readonly liveState?: CheckoutState;
}

export interface ElementsWizardView {
  readonly selectedMethod?: PaymentMethod | null;
  readonly selectedBitcoinRoute?: string | null;
  readonly swapOptions?: readonly ElementsSwapOption[];
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

export type ElementsSwapOption = CheckoutPaymentMethod;

export interface DefineOpenReceiveElementsOptions {
  readonly tagName?: string;
  readonly themeToggleTagName?: string;
  readonly registry?: CustomElementRegistry;
  readonly qrEncoder?: QrEncoder;
  readonly logger?: BrowserLoggerOption;
}

/**
 * `invoice-id` READ AS AN IDENTITY, not as a label — the third server-written
 * attribute the strictness ruling in ./dom-helpers.ts has to cover.
 *
 * `createCheckoutElementAttributes` writes it straight from `invoice.invoice_id`
 * (browser/src/internal/elements.ts), so a server that answers with `""` puts an
 * empty string in the attribute. That reached `createCheckoutSnapshotFromInvoice`,
 * whose `requiredString` threw INSIDE `render()` — and nothing wraps `render()`,
 * so the shadow root stayed empty: no invoice, no error, no signal.
 *
 * `requiredString` is right to throw; it is a parse boundary and other callers
 * depend on it. The judgement belongs HERE, one hop earlier, where the element
 * still has somewhere to put the answer.
 *
 * The rule differs from the lenient NUMBER readers next door, and deliberately.
 * A malformed `amount-msats` costs its label because the payment is still
 * identified; a blank `invoice-id` is not a bad label, it is NO IDENTITY — the
 * element cannot seed a state for the attempt, cannot build the snapshot the
 * poll controller needs, and so can never tell the payer their money arrived.
 * A whitespace-only id is the same nothing wearing a coat (`nonEmptyString` does
 * not trim, so `" "` sails through the parse boundary and becomes a junk id that
 * `createCheckoutSnapshotFromInvoice` then also copies into `checkout_id` and
 * `order_id`), so it is rejected by the same test.
 *
 * A usable id is returned RAW, exactly as the number readers keep their value
 * raw: trimming it here would silently mint an id that matches nothing the
 * server ever sent.
 */
export function parseElementInvoiceId(value: string | null): string | undefined {
  if (value === null || value.trim() === "") return undefined;
  return value;
}

/**
 * The attribute-shaped view as a real checkout state, in the same two hops the
 * element's own snapshot path takes: attempt -> snapshot -> state. Returns
 * undefined in create mode, where no attempt exists yet and the renderer must
 * not show an attempt's status block.
 *
 * An unusable `invoice_id` answers undefined for the same reason and by the same
 * test ({@link parseElementInvoiceId}): the element decides what a view with no
 * identity looks like, and this exported renderer must not throw at a standalone
 * caller who passed one through.
 */
export function createElementCheckoutState(view: CheckoutView): CheckoutState | undefined {
  const invoiceId = parseElementInvoiceId(view.invoice_id ?? null);
  if (invoiceId === undefined) return undefined;
  return createCheckoutState(
    createCheckoutSnapshotFromInvoice({
      invoice_id: invoiceId,
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
