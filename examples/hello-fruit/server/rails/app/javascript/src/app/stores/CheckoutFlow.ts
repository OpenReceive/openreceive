import {
  copyInvoice as copyInvoiceHelper,
  status as deriveStatus,
  OpenReceiveBrowserRequestError,
  prepareCheckout,
  requestCheckout,
  type Status,
} from "@openreceive/browser";
import {
  type CheckoutInvoiceSnapshot,
  type CheckoutSnapshot,
  type CheckoutState,
  type CheckoutStatusModel,
  createCheckoutState,
  createCheckoutStatusModel,
  createOpenReceiveStatusFetcher,
  isReusableLightningInvoice,
  selectCheckoutDisplayInvoice,
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

const unixNow = (): number => Math.floor(Date.now() / 1000);

/**
 * One payment attempt lifecycle for one order: prepare → (mint Lightning |
 * fold in a started swap) → poll until settled/expired. All server round-trips
 * are @modelFlow s; every poll result and every HTTP response lands in the same
 * idempotent snapshot actions, so a late poll can never flip a settled screen
 * back to "waiting" and a slow backend never stacks overlapping requests.
 *
 * The payment wizard — method grid, network reveal, swap deposit panel — is
 * the packaged @openreceive/react PaymentWizard, mounted by CheckoutPanel on
 * this store's snapshot. Everything it decides comes back here as an action: a
 * started swap attempt (applyAttempt), a request for a Lightning invoice
 * (ensureLightning), whether its deposit panel is standing in for the Lightning
 * pane (setSwapFocused), and its errors (reportError). Which tile or network
 * the payer is choosing between is the wizard's own UI state.
 */
@model("helloFruit/CheckoutFlow")
export class CheckoutFlow extends Model({
  orderId: prop<string>(),
  phase: prop<"idle" | "preparing" | "ready" | "error">("idle"),
  prepareErrorMessage: prop<string | null>(null),
  /** Whole-checkout snapshot: the single sink for prepare/mint/swap/poll results. */
  snapshot: prop<Frozen<CheckoutSnapshot> | null>(null),
  mintingLightning: prop<boolean>(false),
  /** The wizard's swap deposit panel has replaced the Lightning pane. */
  swapFocused: prop<boolean>(false),
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
   * rule over this snapshot and shipped the answers on the state, so these take
   * them rather than formatting the raw fields a second time.
   *
   * They used to call `formatOpenReceiveMsats` / `formatOpenReceiveFiatAmount`
   * here. `formatOpenReceiveMsats` THROWS on an amount that is not a non-negative
   * safe integer — correctly, it is the formatter the wire builders share — and
   * these are @computed s read inside an `observer`, so a server answering with a
   * nonsense `amount_msats` took out the whole checkout panel instead of the one
   * label. The packaged derivation routes the same value through the display
   * boundary and simply returns undefined.
   */
  @computed
  get amountLabel(): string | undefined {
    return this.state?.amountLabel;
  }

  @computed
  get fiatLabel(): string | undefined {
    return this.state?.fiatLabel;
  }

  /**
   * The bolt11 the wizard's provider tutorials copy. Read off the snapshot
   * rather than `state`, which is rebuilt every tick of `nowSeconds` and would
   * re-render the whole wizard once a second.
   */
  @computed
  get lightningInvoice(): string | undefined {
    const snapshot = this.snapshot?.data;
    const invoice =
      snapshot === undefined ? undefined : selectCheckoutDisplayInvoice(snapshot)?.invoice;
    return typeof invoice === "string" && invoice.length > 0 ? invoice : undefined;
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
   * back to "waiting for payment".
   */
  @modelAction
  applyPollResult(next: CheckoutSnapshot): void {
    if (this.snapshot !== null && (this.settled || this.state?.terminal === true)) return;
    this.snapshot = frozen(next);
  }

  @modelAction
  setNow(seconds: number): void {
    this.nowSeconds = seconds;
  }

  /** The wizard entered or left its focused swap flow (PaymentWizard onSwapFocusChange). */
  @modelAction
  setSwapFocused(focused: boolean): void {
    this.swapFocused = focused;
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

  /** Surface a failure (ours or the wizard's) on the page's error banner. */
  reportError(error: unknown): void {
    const root = getRoot<{ showError?: (message: string) => void }>(this);
    const message = error instanceof Error ? error.message : String(error);
    root.showError?.(message);
    logDemo("checkout.error", "Checkout action failed.", { orderId: this.orderId, error: message });
  }
}
