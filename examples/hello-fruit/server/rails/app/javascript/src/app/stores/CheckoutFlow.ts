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
  createOpenReceiveStatusFetcher,
  isReusableLightningInvoice,
  normalizeSwapStartInvoice,
  type OpenReceiveCheckoutPaymentMethod,
  type OpenReceiveMethodGridEntry,
  type OpenReceiveSwapMethodGroup,
  openReceivePaymentMethods,
  openReceiveSwapPickerKey,
  postOpenReceiveJson,
  resolveOpenReceivePreservedNetworkSelection,
  selectCheckoutDisplayInvoice,
  startOpenReceiveSwapRequest,
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
import { openReceivePrefix } from "../helpers/constants.ts";
import { logDemo } from "../helpers/logging.ts";

type SwapGroup = OpenReceiveSwapMethodGroup<OpenReceiveCheckoutPaymentMethod>;

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
  /** Which multi-network coin has its network reveal open ("swap:USDT"), if any. */
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
  /** Unix seconds, ticked once per second while the checkout is live (countdowns). */
  nowSeconds: prop<number>(() => unixNow()),
}) {
  // Volatile (non-snapshot) poll bookkeeping — mirrors CheckoutWatcher's rules.
  private pollInFlight = false;
  private pollFailureCount = 0;
  private pollBackoffUntil: number | undefined;
  private settledAnnounced = false;

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

  /**
   * READ, never re-derive. `createCheckoutState` already ran the packaged label
   * rule over this snapshot and shipped the answers on the state, so the port
   * takes them rather than formatting the raw fields a second time.
   *
   * These two used to call `formatOpenReceiveMsats` / `formatOpenReceiveFiatAmount`
   * here. `formatOpenReceiveMsats` THROWS on an amount that is not a non-negative
   * safe integer — correctly, it is the formatter the wire builders share — and
   * these are @computed s read inside an `observer`, so a server answering with a
   * nonsense `amount_msats` took out the whole checkout panel instead of the one
   * label. The packaged derivation routes the same value through the display
   * boundary and simply returns undefined, which is the behaviour the port wanted
   * all along and never has to restate.
   */
  @computed
  get amountLabel(): string | undefined {
    return this.state?.amountLabel;
  }

  @computed
  get fiatLabel(): string | undefined {
    return this.state?.fiatLabel;
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

  /**
   * The coin group whose network reveal is open. Only multi-network coins have
   * one: a single-network coin starts its swap straight from the tile.
   */
  @computed
  get selectedSwapGroup(): SwapGroup | undefined {
    const group = this.findSwapGroup(this.selectedPickerKey);
    return group !== undefined && group.options.length > 1 ? group : undefined;
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
  get focusedSwapOption(): OpenReceiveCheckoutPaymentMethod | undefined {
    if (this.focusedSwapAsset === null) return undefined;
    return this.swapAssetOptions.find((option) => option.pay_in_asset === this.focusedSwapAsset);
  }

  /** Payer is inside the focused swap flow — the Lightning pane hides. */
  @computed
  get swapFocused(): boolean {
    return this.focusedSwapAsset !== null;
  }

  /**
   * The Bitcoin tile is the live target while the active attempt is a bolt11.
   * Read off the snapshot rather than `state`, which is rebuilt every tick of
   * `nowSeconds` and would re-render the whole grid once a second.
   */
  @computed
  get lightningSelected(): boolean {
    return this.snapshot?.data.active?.rail === "lightning";
  }

  /** The grid's coin group for a picker key ("swap:USDT"), or undefined. */
  private findSwapGroup(pickerKey: string | null): SwapGroup | undefined {
    if (pickerKey === null) return undefined;
    const entry = this.gridEntries.find(
      (entry) => entry.kind === "swap" && openReceiveSwapPickerKey(entry.group.label) === pickerKey,
    );
    return entry?.kind === "swap" ? entry.group : undefined;
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
  setNow(seconds: number): void {
    this.nowSeconds = seconds;
  }

  // ---- grid selection -------------------------------------------------------

  /**
   * Open a coin's network reveal. Carries the payer's network choice across
   * coins that offer the same one (USDT/Tron → USDC/Tron) via the packaged
   * resolver, and drops it when the new coin cannot honour it.
   */
  @modelAction
  selectSwapGroup(pickerKey: string): void {
    const previousGroup = this.selectedSwapGroup;
    this.selectedPickerKey = pickerKey;
    const nextGroup = this.findSwapGroup(pickerKey);
    if (nextGroup === undefined || nextGroup.options.length <= 1) return;
    const preserved = resolveOpenReceivePreservedNetworkSelection({
      previousGroup,
      nextGroup,
      selectedNetworks: this.selectedSwapNetworks,
    });
    const groupKey = nextGroup.label.trim().toUpperCase();
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

  /** The Bitcoin tile: close any open network reveal; the caller mints the bolt11. */
  @modelAction
  selectLightning(): void {
    this.selectedPickerKey = null;
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
      const invoice = yield* _await(
        startOpenReceiveSwapRequest({
          fetch: globalThis.fetch,
          prefix: openReceivePrefix(),
          orderId: this.orderId,
          payInAsset,
        }),
      );
      this.applyAttempt(invoice);
      this.focusedSwapAsset = payInAsset;
      this.dismissedSwapInvoiceId = null;
      logDemo("swap.started", "Swap deposit address ready.", {
        orderId: this.orderId,
        payInAsset,
      });
    } catch (error) {
      // Focus the coin anyway: the failure belongs on its panel, with a retry,
      // rather than as a toast over a grid that still looks ready.
      this.focusedSwapAsset = payInAsset;
      this.setSwapStartError(error);
      this.reportError(error);
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
        postOpenReceiveJson({
          fetch: globalThis.fetch,
          prefix: openReceivePrefix(),
          body: {
            order_id: this.orderId,
            payment_hash: payment.payment_hash,
            action: "refund_swap",
            attempt_id: attemptId,
            refund_address: refundAddress,
            refund_nonce: refundNonce,
            confirm,
          },
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
        prefix: openReceivePrefix(),
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
