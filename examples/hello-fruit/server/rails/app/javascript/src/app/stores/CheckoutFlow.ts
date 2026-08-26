import {
  copyInvoice as copyInvoiceHelper,
  deriveStatus,
  prepareCheckout,
  requestCheckout,
  type Status,
} from "@openreceive/browser";
import {
  type CheckoutController,
  type CheckoutInvoiceSnapshot,
  type CheckoutSnapshot,
  type CheckoutState,
  type CheckoutStatusModel,
  createCheckoutController,
  createCheckoutState,
  createCheckoutStatusModel,
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
 * fold in a started swap) → poll until settled/expired.
 *
 * The POLL LOOP is not written here. `createCheckoutController` owns it — one
 * request at a time, Retry-After-aware backoff, the countdown, the stop rules
 * for a settled or terminal attempt, and the staged swap-refund address that a
 * status tick would otherwise wipe. This store is the state layer above it: it
 * holds the snapshot the controller publishes, derives everything the panel
 * renders from it, and hands actions back down. That is the whole shape of a
 * headless integration — bring your own store, not your own engine.
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
  /**
   * The packaged poll loop. Volatile, never part of the keystone snapshot, and
   * rebuilt whenever the checkout it watches changes identity — a swap start
   * re-keys `checkout_id`, and a controller still pointed at the pre-swap
   * Lightning attempt is how a paid swap customer gets told "Invoice expired".
   */
  private controller: CheckoutController | undefined;
  private controllerKey: string | undefined;
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
   * They used to call `formatMsats` / `formatFiatAmount`
   * here. `formatMsats` THROWS on an amount that is not a non-negative
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
    this.syncController();
  }

  /** Fold a started attempt (swap deposit or minted bolt11) into the snapshot. */
  @modelAction
  applyAttempt(invoice: CheckoutInvoiceSnapshot): void {
    const base: CheckoutSnapshot = this.snapshot?.data ?? {
      checkout_id: invoice.invoice_id,
      reference: this.orderId,
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
    this.syncController();
  }

  /**
   * Poll sink. A result that raced a settlement must never flip a paid screen
   * back to "waiting for payment".
   */
  @modelAction
  applyPollResult(next: CheckoutSnapshot): void {
    // The controller already refuses to flip its own state back; this guard is
    // for the OTHER door — the cable push and any host-driven refresh, which do
    // not go through the watcher.
    if (this.snapshot !== null && (this.settled || this.state?.terminal === true)) return;
    this.snapshot = frozen(next);
    this.announceSettledIfNeeded();
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
        prepareCheckout({ prefix: openReceivePrefix(), reference: this.orderId }),
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
      // `previous` is what keeps the warmed pay-in catalog (and any sibling
      // swap attempt) alive across the mint: the mint response carries the
      // bolt11 and the catalog, and the package folds the two snapshots
      // together. Re-attaching `payment_methods` by hand afterwards was this
      // store doing the package's job, one merge rule out of date.
      const current = this.snapshot?.data;
      const checkout = yield* _await(
        requestCheckout({
          prefix: openReceivePrefix(),
          reference: this.orderId,
          ...(current === undefined ? {} : { previous: current }),
        }),
      );
      const minted = selectCheckoutDisplayInvoice(checkout) ?? checkout.active;
      if (minted === undefined) {
        this.applyPrepared(checkout);
      } else {
        this.applyPrepared(checkout);
        this.applyAttempt(minted);
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

  /** Copy the bolt11; the shared CopyInvoiceButton renders the transient feedback. */
  @modelFlow
  copyInvoice = _async(function* (this: CheckoutFlow) {
    const controller = this.controller;
    if (controller !== undefined) {
      yield* _await(controller.copyInvoice());
      return;
    }
    const invoice = this.state?.invoice;
    if (invoice === undefined || invoice === "") return;
    yield* _await(copyInvoiceHelper({ invoice }));
  });

  // ---- the two-step swap refund ---------------------------------------------
  //
  // Handed to the mounted PaymentWizard as its `swapRefund`. Step one posts
  // /swaps/status and STAGES the address the payer typed; step two is the only
  // call that posts /swaps/refunds. The staged address lives in the controller,
  // so the next status tick cannot wipe a review in progress — this store does
  // not have to remember an overlay rule, and neither does the panel.

  async stageSwapRefund(options: {
    readonly attemptId: string;
    readonly refundAddress: string;
  }): Promise<CheckoutInvoiceSnapshot> {
    return this.requireController().stageSwapRefund(options);
  }

  async confirmSwapRefund(options: {
    readonly attemptId: string;
    readonly refundAddress: string;
  }): Promise<CheckoutInvoiceSnapshot> {
    return this.requireController().confirmSwapRefund(options);
  }

  /** The payer left the swap for Lightning — the one exit that is not a refund. */
  clearSwapRefundStaging(): void {
    this.controller?.clearSwapRefundStaging();
  }

  /**
   * A cable push told us the server settled this order — refresh immediately
   * instead of waiting for the next poll interval.
   */
  wakeFromServerPush(): void {
    void this.controller?.reloadState().catch((error: unknown) => this.reportError(error));
  }

  /** Stop the poll loop. The workspace calls this when it leaves the order. */
  stopWatching(): void {
    this.controller?.stop();
    this.controller = undefined;
    this.controllerKey = undefined;
  }

  /**
   * Point the poll loop at the checkout the snapshot now describes, rebuilding
   * it when that identity changes. Cheap and idempotent: every snapshot sink
   * calls it, and only a re-key does any work.
   */
  private syncController(): void {
    const snapshot = this.snapshot?.data;
    if (snapshot === undefined) {
      this.stopWatching();
      return;
    }
    const key = `${snapshot.checkout_id} ${snapshot.reference}`;
    if (this.controller !== undefined && this.controllerKey === key) return;
    this.controller?.stop();
    this.controllerKey = key;
    this.controller = createCheckoutController({
      snapshot,
      prefix: openReceivePrefix(),
      logger: false,
      // The engine's one output this store cares about. `onState` is
      // deliberately unused: `state` here is a @computed over the snapshot and
      // this store's own 1 Hz clock, and reading a per-tick state object would
      // re-render the whole wizard once a second.
      onSnapshot: (next) => this.applyPollResult(next),
      onError: (error) => {
        logDemo("checkout.poll_error", "Payment status poll failed; backing off.", {
          orderId: this.orderId,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
    this.controller.start();
  }

  private requireController(): CheckoutController {
    const controller = this.controller;
    if (controller === undefined) {
      throw new Error("This checkout is not being watched yet.");
    }
    return controller;
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
