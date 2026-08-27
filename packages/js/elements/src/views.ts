import {
  type AssetUrlResolver,
  type CheckoutInvoiceSnapshot,
  type CheckoutState,
  createCheckoutSnapshotFromInvoice,
  createCheckoutState,
  type BrowserLoggerOption,
  type CheckoutPaymentMethod,
  type PaymentMethod,
  type QrEncoder,
  type Status,
  type SwapLimitContext,
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
  /**
   * What the payer is buying, in the host's own words — the `description` the
   * host returned from its amount hook, echoed on the prepare and create
   * responses. One display string; anything richer is host markup in the
   * element's `order` slot.
   */
  readonly description?: string;
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
  readonly selectedSwapAssetByGroup?: Readonly<Record<string, string>>;
  /** Compact selector highlight: `method:bitcoin` or `swap:USDT`. */
  readonly selectedPickerKey?: string | null;
  /** Pay-in asset whose swap create is in flight — method tiles spin and disable. */
  readonly startingSwapAsset?: string | null;
  /** When set, the wizard shows the focused swap deposit flow for this pay-in asset. */
  readonly selectedSwapAsset?: string | null;
  /**
   * Whether this checkout has a URL the payer can return to — `sync-url` is
   * set, or the host mounted the element on its own per-order route. Decides
   * which of the two refund-return warnings the deposit panel shows; see
   * {@link SwapDisplayModel.refundReturnLabel}.
   */
  readonly resumable?: boolean;
  /** Invoice amount + fiat, used to render fiat limit messages for out-of-range assets. */
  readonly amountMsats?: number;
  readonly fiat?: { readonly currency?: string; readonly value?: string };
  readonly reference?: string;
  readonly checkoutId?: string;
  /** Display Lightning BOLT11 from the checkout (swap shadows may omit invoice). */
  readonly lightningInvoice?: string;
  /** Host-chosen bolt11 decoder base URL; omitted, the tutorial shows no decode link. */
  readonly decodeLinkUrl?: string;
  /**
   * Rewrite a packaged asset path (`assets/icons/btc.svg`,
   * `assets/provider-icons/strike.png`) into a URL this host can serve. The
   * packaged URLs only resolve under Vite/Rollup; every other bundler needs
   * this or the icons come out as dead `file://` links. `defineElements` passes
   * its own down to here.
   */
  readonly resolveAssetUrl?: AssetUrlResolver;
  readonly paymentHash?: string;
  readonly swapInvoice?: CheckoutInvoiceSnapshot;
  readonly activeTutorialProviderId?: string | null;
  readonly activeTutorialIndex?: number;
  readonly activeTutorialCopied?: boolean;
  /** Swap-start failure rendered inline in the deposit slot with a retry button. */
  readonly swapStartError?: string;
  /**
   * The quote for the selected pay-in asset when it came back unavailable, so
   * the deposit slot shows the accepted range instead of a generic error.
   * Matches React's `renderSwapUnavailable` pane.
   */
  readonly unavailableSwapQuote?: CheckoutPaymentMethod;
  /** Checkout context the unavailable panel converts invoice-side limits with. */
  readonly swapLimitContext?: SwapLimitContext;
  /** Wizard-level failure (e.g. Lightning mint) rendered inline. */
  readonly wizardError?: string;
}

export type ElementsSwapOption = CheckoutPaymentMethod;

export interface DefineElementsOptions {
  readonly tagName?: string;
  readonly themeToggleTagName?: string;
  readonly registry?: CustomElementRegistry;
  readonly qrEncoder?: QrEncoder;
  readonly logger?: BrowserLoggerOption;
  /**
   * Element-owned, like `qrEncoder` and `logger`: how this host resolves the
   * packaged icon and tutorial paths. Omitted, the packaged URLs are used —
   * correct under Vite/Rollup and dead `file://` links under anything else.
   */
  readonly resolveAssetUrl?: AssetUrlResolver;
}

/**
 * `invoice-id` as the CREATE-MODE DISCRIMINATOR: present and non-blank means
 * the host handed this element an existing attempt; null, empty, or
 * whitespace-only means there is no attempt yet.
 *
 * Whitespace counts as absent because `nonEmptyString` does not trim, so `" "`
 * would otherwise sail through the parse boundary and become a junk id that
 * `createCheckoutSnapshotFromInvoice` copies into `checkout_id` and
 * `reference` too.
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
 * A blank `invoice_id` answers undefined by the same test
 * ({@link parseElementInvoiceId}): no id means no attempt to show a status
 * block for.
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
