import {
  copyInvoice as copyInvoiceHelper,
  status as deriveStatus,
  OpenReceiveBrowserRequestError,
  prepareCheckout,
  requestCheckout,
  type Status,
} from "@openreceive/browser";
import {
  buildOpenReceiveMethodGridEntries,
  type CheckoutInvoiceSnapshot,
  type CheckoutSnapshot,
  type CheckoutState,
  type CheckoutStatusModel,
  createCheckoutState,
  createCheckoutStatusModel,
  createOpenReceivePaymentWizardSelection,
  createOpenReceiveStatusFetcher,
  createOpenReceiveSwapDisplayModel,
  formatOpenReceiveFiatAmount,
  formatOpenReceiveMsats,
  isReusableLightningInvoice,
  normalizeSwapStartInvoice,
  type OpenReceiveCheckoutPaymentMethod,
  type OpenReceiveMethodGridEntry,
  type OpenReceivePaymentMethod,
  type OpenReceivePaymentWizardSelection,
  type OpenReceiveSwapDisplayModel,
  openReceivePaymentMethods,
  postOpenReceiveJson,
  resolveOpenReceivePreservedNetworkSelection,
  selectCheckoutDisplayInvoice,
  startOpenReceiveSwapRequest,
  updateOpenReceivePaymentWizardSelection,
} from "@openreceive/browser/headless";
import { computed } from "mobx";
import {
  _async,
  _await,
  type Frozen,
  frozen,
  getRoot,
  Model,
  model,
  modelAction,
  modelFlow,
  prop,
} from "mobx-keystone";
import { openReceivePrefix, orderStatusUrl } from "../helpers/constants.ts";
import { logDemo } from "../helpers/logging.ts";

export interface CheckoutTutorialState {
  readonly providerId: string;
  readonly index: number;
  readonly copied: boolean;
}

const unixNow = (): number => Math.floor(Date.now() / 1000);

/**
 * One payment attempt lifecycle for one order: prepare → (mint Lightning |
 * start swap) → poll until settled/expired. All server round-trips are
 * @modelFlow s; every poll result and every HTTP response lands in the same
 * idempotent snapshot actions, so a late poll can never flip a settled screen
 * back to "waiting" and a slow backend never stacks overlapping requests.
 */
@model("helloFruit/CheckoutFlow")
export class CheckoutFlow extends Model({
  orderId: prop<string>(),
  phase: prop<"idle" | "preparing" | "ready" | "error">("idle"),
  prepareErrorMessage: prop<string | null>(null),
  /** Whole-checkout snapshot: the single sink for prepare/mint/swap/poll results. */
  snapshot: prop<Frozen<CheckoutSnapshot> | null>(null),
  mintingLightning: prop<boolean>(false),
  /** Bitcoin/crypto wizard selection (breadcrumb flow), advanced via the pure updater. */
  wizardSelection: prop<Frozen<OpenReceivePaymentWizardSelection> | null>(null),
  /** Which method tile is selected in the compact grid ("method:…" / "swap:…"). */
  selectedPickerKey: prop<string | null>(null),
  /** Chosen network per multi-network coin, keyed by upper-cased group label. */
  selectedSwapNetworks: prop<Record<string, string>>(() => ({})),
  /** pay_in_asset of the swap currently being started (grid busy state). */
  startingAsset: prop<string | null>(null),
  /** pay_in_asset of the focused swap flow (deposit panel replaces the grid). */
  focusedSwapAsset: prop<string | null>(null),
  swapStartError: prop<string | null>(null),
  /** "Pay with Bitcoin instead" dismissed this swap attempt. */
  dismissedSwapInvoiceId: prop<string | null>(null),
  swapQuotes: prop<Frozen<Record<string, OpenReceiveCheckoutPaymentMethod>>>(() => frozen({})),
  activeTutorial: prop<CheckoutTutorialState | null>(null),
  /** Unix seconds, ticked once per second while the checkout is live (countdowns). */
  nowSeconds: prop<number>(() => unixNow()),
}) {
  // Volatile (non-snapshot) poll bookkeeping — mirrors CheckoutWatcher's rules.
  private pollInFlight = false;
  private pollFailureCount = 0;
  private pollBackoffUntil: number | undefined;
  private settledAnnounced = false;
  private autoRetriedAssets = new Set<string>();

  @computed
  get state(): CheckoutState | undefined {
    const snapshot = this.snapshot?.data;
    if (snapshot === undefined) return undefined;
    return createCheckoutState(snapshot, { now: this.nowSeconds, logger: false });
  }

  @computed
  get status(): Status {
    const snapshot = this.snapshot?.data;
    if (snapshot === undefined) return "pending";
    if (snapshot.status === "paid") return "settled";
    if (snapshot.status === "expired") return "expired";
    const state = this.state;
    return state === undefined ? "pending" : deriveStatus(state);
  }

  @computed
  get statusModel(): CheckoutStatusModel {
    return createCheckoutStatusModel(this.state, { now: this.nowSeconds });
  }

  @computed
  get settled(): boolean {
    return this.status === "settled";
  }

  @computed
  get expired(): boolean {
    return this.status === "expired";
  }

  @computed
  get amountLabel(): string | undefined {
    const amountMsats = this.state?.amount_msats;
    return amountMsats === undefined ? undefined : formatOpenReceiveMsats(amountMsats);
  }

  @computed
  get fiatLabel(): string | undefined {
    return formatOpenReceiveFiatAmount(this.state?.fiat_quote?.fiat);
  }

  @computed
  get swapAssetOptions(): readonly OpenReceiveCheckoutPaymentMethod[] {
    const methods = this.snapshot?.data.payment_methods ?? [];
    return methods.filter((option) => option.provider.length > 0);
  }

  @computed
  get gridEntries(): readonly OpenReceiveMethodGridEntry<OpenReceiveCheckoutPaymentMethod>[] {
    return buildOpenReceiveMethodGridEntries(openReceivePaymentMethods, this.swapAssetOptions);
  }

  /** Create-time snapshots have no payment_methods until the catalog warms. */
  @computed
  get currenciesLoading(): boolean {
    return (
      this.snapshot !== null &&
      this.snapshot.data.payment_methods === undefined &&
      this.swapAssetOptions.length === 0
    );
  }

  @computed
  get currentSwapInvoice(): CheckoutInvoiceSnapshot | undefined {
    return this.snapshot?.data.invoices.find(
      (invoice) =>
        invoice.rail === "swap" &&
        invoice.swap !== undefined &&
        invoice.invoice_id !== this.dismissedSwapInvoiceId,
    );
  }

  @computed
  get activeSwapForFocusedAsset(): CheckoutInvoiceSnapshot | undefined {
    if (this.focusedSwapAsset === null) return undefined;
    const invoice = this.currentSwapInvoice;
    return invoice?.swap?.pay_in_asset === this.focusedSwapAsset ? invoice : undefined;
  }

  @computed
  get swapDisplayModel(): OpenReceiveSwapDisplayModel | undefined {
    const invoice = this.activeSwapForFocusedAsset;
    if (invoice === undefined) return undefined;
    return createOpenReceiveSwapDisplayModel(invoice, { now: this.nowSeconds });
  }

  @computed
  get focusedSwapOption(): OpenReceiveCheckoutPaymentMethod | undefined {
    if (this.focusedSwapAsset === null) return undefined;
    return (
      this.swapAssetOptions.find((option) => option.pay_in_asset === this.focusedSwapAsset) ??
      this.swapQuotes.data[this.focusedSwapAsset]
    );
  }

  @computed
  get focusedSwapQuote(): OpenReceiveCheckoutPaymentMethod | undefined {
    return this.focusedSwapAsset === null ? undefined : this.swapQuotes.data[this.focusedSwapAsset];
  }

  /** Payer is inside the focused swap flow — the Lightning pane hides. */
  @computed
  get swapFocused(): boolean {
    return this.focusedSwapAsset !== null;
  }

  @computed
  get selectedMethod(): OpenReceivePaymentMethod | null {
    return this.wizardSelection?.data.selectedMethod ?? null;
  }

  // ---- snapshot sinks -------------------------------------------------------

  @modelAction
  applyPrepared(snapshot: CheckoutSnapshot): void {
    this.snapshot = frozen(snapshot);
    this.phase = "ready";
    this.prepareErrorMessage = null;
  }

  /** Fold a started attempt (swap deposit or minted bolt11) into the snapshot. */
  @modelAction
  applyAttempt(invoice: CheckoutInvoiceSnapshot): void {
    const base: CheckoutSnapshot = this.snapshot?.data ?? {
      checkout_id: invoice.invoice_id,
      order_id: this.orderId,
      status: "open",
      amount_msats: invoice.amount_msats ?? 0,
      invoices: [],
    };
    const withoutSame = base.invoices.filter(
      (entry) => entry.invoice_id !== invoice.invoice_id && entry.rail !== "checkout_lock",
    );
    this.snapshot = frozen({
      ...base,
      checkout_id: invoice.invoice_id,
      active: invoice,
      invoices: [invoice, ...withoutSame],
      ...(invoice.amount_msats === undefined ? {} : { amount_msats: invoice.amount_msats }),
    });
  }

  /**
   * Poll sink. A result that raced a settlement must never flip a paid screen
   * back to "waiting for payment"; locally staged refund address/nonce survive
   * poll results that omit them.
   */
  @modelAction
  applyPollResult(next: CheckoutSnapshot): void {
    const current = this.snapshot?.data;
    if (current !== undefined && (this.settled || this.state?.terminal === true)) return;
    const previousActive = current?.invoices.find(
      (invoice) => invoice.invoice_id === next.active?.invoice_id,
    );
    const active = next.active;
    if (
      active?.swap !== undefined &&
      previousActive?.swap !== undefined &&
      (active.swap.refund_address === undefined || active.swap.refund_nonce === undefined)
    ) {
      const mergedSwap = {
        ...active.swap,
        ...(active.swap.refund_address === undefined &&
        previousActive.swap.refund_address !== undefined
          ? { refund_address: previousActive.swap.refund_address }
          : {}),
        ...(active.swap.refund_nonce === undefined && previousActive.swap.refund_nonce !== undefined
          ? { refund_nonce: previousActive.swap.refund_nonce }
          : {}),
      };
      const mergedActive = { ...active, swap: mergedSwap };
      this.snapshot = frozen({ ...next, active: mergedActive, invoices: [mergedActive] });
      return;
    }
    this.snapshot = frozen(next);
  }

  @modelAction
  private setSwapQuote(payInAsset: string, quote: OpenReceiveCheckoutPaymentMethod): void {
    this.swapQuotes = frozen({ ...this.swapQuotes.data, [payInAsset]: quote });
  }

  @modelAction
  setNow(seconds: number): void {
    this.nowSeconds = seconds;
  }

  @modelAction
  setActiveTutorial(tutorial: CheckoutTutorialState | null): void {
    this.activeTutorial = tutorial;
  }

  // ---- wizard / grid selection ---------------------------------------------

  /** Select a method tile or reveal a coin's network choices. Port of the widget's onSelectPicker. */
  @modelAction
  selectPicker(key: string): void {
    const previousKey = this.selectedPickerKey;
    this.selectedPickerKey = key;
    if (!key.startsWith("swap:")) return;
    const label = key.slice("swap:".length);
    const entries = this.gridEntries;
    const nextEntry = entries.find(
      (entry) => entry.kind === "swap" && entry.group.label.trim().toUpperCase() === label,
    );
    if (nextEntry === undefined || nextEntry.kind !== "swap") return;
    if (nextEntry.group.options.length <= 1) return;
    const previousGroup = previousKey?.startsWith("swap:")
      ? entries.find(
          (entry) =>
            entry.kind === "swap" &&
            entry.group.label.trim().toUpperCase() === previousKey.slice("swap:".length),
        )
      : undefined;
    const preserved = resolveOpenReceivePreservedNetworkSelection({
      previousGroup: previousGroup?.kind === "swap" ? previousGroup.group : undefined,
      nextGroup: nextEntry.group,
      selectedNetworks: this.selectedSwapNetworks,
    });
    const groupKey = nextEntry.group.label.trim().toUpperCase();
    if (preserved === undefined) {
      delete this.selectedSwapNetworks[groupKey];
    } else {
      this.selectedSwapNetworks[groupKey] = preserved;
    }
  }

  @modelAction
  selectNetwork(groupKey: string, payInAsset: string): void {
    this.selectedSwapNetworks[groupKey] = payInAsset;
  }

  @modelAction
  selectMethod(methodId: OpenReceivePaymentMethod): void {
    const selection = this.wizardSelection?.data ?? createOpenReceivePaymentWizardSelection();
    this.wizardSelection = frozen(
      updateOpenReceivePaymentWizardSelection(selection, {
        type: "select_method",
        method: methodId,
      }),
    );
  }

  @modelAction
  changeMethod(): void {
    const selection = this.wizardSelection?.data;
    if (selection === undefined) return;
    this.wizardSelection = frozen(
      updateOpenReceivePaymentWizardSelection(selection, { type: "change_method" }),
    );
  }

  @modelAction
  selectRoute(route: string): void {
    const selection = this.wizardSelection?.data;
    if (selection === undefined) return;
    this.wizardSelection = frozen(
      updateOpenReceivePaymentWizardSelection(selection, { type: "select_route", route }),
    );
  }

  @modelAction
  changeRoute(): void {
    const selection = this.wizardSelection?.data;
    if (selection === undefined) return;
    this.wizardSelection = frozen(
      updateOpenReceivePaymentWizardSelection(selection, { type: "change_route" }),
    );
  }

  /** Leave the focused swap flow and restore the default method grid. */
  @modelAction
  clearSwapFocus(): void {
    this.focusedSwapAsset = null;
    this.selectedPickerKey = null;
    this.selectedSwapNetworks = {};
    this.swapStartError = null;
  }

  // ---- server round-trips ---------------------------------------------------

  @modelFlow
  prepare = _async(function* (this: CheckoutFlow) {
    this.phase = "preparing";
    this.prepareErrorMessage = null;
    try {
      const snapshot = yield* _await(
        prepareCheckout({ prefix: openReceivePrefix(), orderId: this.orderId }),
      );
      this.applyPrepared(snapshot);
      logDemo("checkout.prepared", "Checkout prepared (amount locked, methods loaded).", {
        orderId: this.orderId,
        amountMsats: snapshot.amount_msats,
      });
    } catch (error) {
      this.phase = "error";
      this.prepareErrorMessage =
        error instanceof Error && error.message.length > 0 ? error.message : null;
      logDemo("checkout.prepare_error", "Checkout prepare failed.", {
        orderId: this.orderId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * Ensure a payable bolt11 exists: reuse one with >60s left, otherwise mint.
   * Safe to call repeatedly (Bitcoin tile, back-from-swap).
   */
  @modelFlow
  ensureLightning = _async(function* (this: CheckoutFlow) {
    const current = this.snapshot?.data;
    if (current !== undefined) {
      const reusable = current.invoices.find(
        (invoice) =>
          invoice.rail === "lightning" &&
          typeof invoice.invoice === "string" &&
          invoice.invoice.length > 0 &&
          invoice.expires_at !== undefined &&
          isReusableLightningInvoice(invoice.expires_at),
      );
      if (reusable !== undefined) {
        this.applyAttempt(reusable);
        return;
      }
    }
    if (this.mintingLightning) return;
    this.mintingLightning = true;
    try {
      const checkout = yield* _await(
        requestCheckout({ prefix: openReceivePrefix(), orderId: this.orderId }),
      );
      const minted = selectCheckoutDisplayInvoice(checkout) ?? checkout.active;
      const previousMethods = this.snapshot?.data.payment_methods;
      if (minted === undefined) {
        this.applyPrepared({
          ...checkout,
          ...(previousMethods === undefined ? {} : { payment_methods: previousMethods }),
        });
      } else {
        if (this.snapshot === null) this.applyPrepared(checkout);
        this.applyAttempt(minted);
        if (previousMethods !== undefined && this.snapshot !== null) {
          this.applyPrepared({ ...this.snapshot.data, payment_methods: previousMethods });
        }
      }
      logDemo("checkout.lightning_ready", "Lightning invoice minted or reused.", {
        orderId: this.orderId,
      });
    } catch (error) {
      this.reportError(error);
    } finally {
      this.mintingLightning = false;
    }
  });

  /** Start (or retry) a swap for one pay-in asset; lands on the deposit panel. */
  @modelFlow
  startSwap = _async(function* (this: CheckoutFlow, payInAsset: string) {
    if (this.startingAsset !== null) return;
    this.startingAsset = payInAsset;
    this.swapStartError = null;
    try {
      let invoice: CheckoutInvoiceSnapshot | undefined;
      try {
        invoice = yield* _await(
          startOpenReceiveSwapRequest(
            globalThis.fetch,
            orderStatusUrl(),
            this.orderId,
            payInAsset,
            {},
          ),
        );
      } catch (error) {
        this.focusedSwapAsset = payInAsset;
        this.setSwapStartError(error);
        this.reportError(error);
        // Quote the asset so an out-of-range amount shows the limits panel
        // instead of a bare error, and retry the start once when the quote
        // says the asset is available (e.g. "address still being prepared").
        if (!this.autoRetriedAssets.has(payInAsset)) {
          this.autoRetriedAssets.add(payInAsset);
          const quote = yield* _await(this.fetchQuote(payInAsset));
          if (quote?.available && this.focusedSwapAsset === payInAsset) {
            try {
              invoice = yield* _await(
                startOpenReceiveSwapRequest(
                  globalThis.fetch,
                  orderStatusUrl(),
                  this.orderId,
                  payInAsset,
                  {},
                ),
              );
              this.swapStartError = null;
            } catch (retryError) {
              this.setSwapStartError(retryError);
            }
          }
        }
      }
      if (invoice !== undefined) {
        this.applyAttempt(invoice);
        this.focusedSwapAsset = payInAsset;
        this.dismissedSwapInvoiceId = null;
        this.swapStartError = null;
        logDemo("swap.started", "Swap deposit address ready.", {
          orderId: this.orderId,
          payInAsset,
        });
      }
    } finally {
      this.startingAsset = null;
    }
  });

  @modelAction
  private setSwapStartError(error: unknown): void {
    this.swapStartError =
      error instanceof Error && error.message.length > 0
        ? error.message
        : "Could not prepare the payment address. Please try again.";
  }

  @modelFlow
  fetchQuote = _async(function* (this: CheckoutFlow, payInAsset: string) {
    try {
      const body = yield* _await(
        postOpenReceiveJson(globalThis.fetch, orderStatusUrl(), {
          order_id: this.orderId,
          action: "swap_quote",
          pay_in_asset: payInAsset,
        }),
      );
      const record = (body ?? {}) as Record<string, unknown>;
      const quote = (record.quote ?? record) as Record<string, unknown>;
      const asset = quote.pay_in_asset ?? quote.pay_asset;
      if (typeof asset !== "string") return undefined;
      const normalized = {
        ...quote,
        pay_in_asset: asset,
      } as unknown as OpenReceiveCheckoutPaymentMethod;
      this.setSwapQuote(asset, normalized);
      return normalized;
    } catch (error) {
      this.swapStartError =
        error instanceof Error && error.message.length > 0
          ? error.message
          : "Could not prepare the payment address. Please try again.";
      this.reportError(error);
      return undefined;
    }
  });

  @modelFlow
  refundSwap = _async(function* (
    this: CheckoutFlow,
    attemptId: string,
    refundAddress: string,
    refundNonce: string,
    confirm: boolean,
  ) {
    try {
      const payment = this.snapshot?.data.invoices.find(
        (invoice) => (invoice.swap?.attempt_id ?? invoice.invoice_id) === attemptId,
      );
      if (payment?.payment_hash === undefined) {
        throw new Error("Swap refund requires the original payment hash.");
      }
      const body = yield* _await(
        postOpenReceiveJson(globalThis.fetch, orderStatusUrl(), {
          order_id: this.orderId,
          payment_hash: payment.payment_hash,
          action: "refund_swap",
          attempt_id: attemptId,
          refund_address: refundAddress,
          refund_nonce: refundNonce,
          confirm,
        }),
      );
      const invoice = normalizeSwapStartInvoice(body);
      this.applyAttempt(invoice);
      this.dismissedSwapInvoiceId = null;
    } catch (error) {
      this.reportError(error);
    }
  });

  /** "Pay with Bitcoin instead" from the deposit panel. */
  @modelFlow
  dismissSwapToLightning = _async(function* (this: CheckoutFlow) {
    const active = this.activeSwapForFocusedAsset;
    if (active !== undefined) this.dismissedSwapInvoiceId = active.invoice_id;
    this.clearSwapFocus();
    yield* _await(this.ensureLightning());
  });

  /**
   * One poll tick: /openreceive/payments/check (+ /swaps/status for a live
   * swap). One request at a time; failures back off (honoring Retry-After);
   * settled/terminal checkouts stop polling.
   */
  @modelFlow
  pollTick = _async(function* (this: CheckoutFlow) {
    const snapshot = this.snapshot?.data;
    const state = this.state;
    if (snapshot === undefined || state === undefined) return;
    if (this.settled || state.terminal) return;
    const paymentHash = state.payment_hash;
    if (
      state.rail === "checkout_lock" ||
      typeof paymentHash !== "string" ||
      !/^[0-9a-f]{64}$/i.test(paymentHash)
    ) {
      return;
    }
    if (this.pollInFlight) return;
    if (this.pollBackoffUntil !== undefined && unixNow() < this.pollBackoffUntil) return;
    this.pollInFlight = true;
    const polledOrderId = this.orderId;
    try {
      const refresh = createOpenReceiveStatusFetcher({
        orderUrl: orderStatusUrl(),
        snapshot,
      });
      const next = yield* _await(refresh(this.orderId));
      this.pollFailureCount = 0;
      this.pollBackoffUntil = undefined;
      if (next === null || polledOrderId !== this.orderId) return;
      this.applyPollResult(next);
      this.announceSettledIfNeeded();
    } catch (error) {
      this.pollFailureCount += 1;
      const retryAfterSeconds =
        error instanceof OpenReceiveBrowserRequestError ? error.retryAfterSeconds : undefined;
      const backoffSeconds =
        retryAfterSeconds ?? Math.min(60, 2 ** Math.min(this.pollFailureCount, 6));
      this.pollBackoffUntil = unixNow() + backoffSeconds;
      logDemo("checkout.poll_error", "Payment status poll failed; backing off.", {
        orderId: this.orderId,
        backoffSeconds,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.pollInFlight = false;
    }
  });

  /** Copy the bolt11; the shared CopyInvoiceButton renders the transient feedback. */
  @modelFlow
  copyInvoice = _async(function* (this: CheckoutFlow) {
    const invoice = this.state?.invoice;
    if (invoice === undefined || invoice === "") return;
    yield* _await(copyInvoiceHelper({ invoice }));
  });

  /**
   * A cable push told us the server settled this order — refresh immediately
   * instead of waiting for the next poll interval.
   */
  wakeFromServerPush(): void {
    void this.pollTick();
  }

  @modelAction
  announceSettledIfNeeded(): void {
    if (!this.settled || this.settledAnnounced) return;
    this.settledAnnounced = true;
    const root = getRoot<{ onCheckoutSettled?: (orderId: string) => void }>(this);
    root.onCheckoutSettled?.(this.orderId);
  }

  private reportError(error: unknown): void {
    const root = getRoot<{ showError?: (message: string) => void }>(this);
    const message = error instanceof Error ? error.message : String(error);
    root.showError?.(message);
    logDemo("checkout.error", "Checkout action failed.", { orderId: this.orderId, error: message });
  }
}
