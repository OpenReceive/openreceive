// The polling loop and the controller around it: CheckoutWatcher owns the
// interval, the terminal-state stop rules, the subscriber list and the staged
// swap-refund address; BrowserCheckoutController is the object the UI packages
// drive.

import { unixSeconds } from "@openreceive/core";
import {
  type CheckoutController,
  type CheckoutControllerOptions,
  type CheckoutInvoiceSnapshot,
  type CheckoutSnapshot,
  type CheckoutState,
  type CheckoutWatcherOptions,
  OPENRECEIVE_DEFAULT_POLL_INTERVAL_MS,
} from "./ui.ts";
import { checkoutLogFields, emitBrowserLog } from "./checkout-log.ts";
import { createStatusFetcher, BrowserRequestError } from "./checkout-transport.ts";
import {
  createCheckoutState,
  normalizeCheckoutState,
  refreshCheckoutState,
} from "./checkout-state.ts";
import { copyInvoice, openWallet } from "./checkout-actions.ts";
import { overlaySwapRefundStagingIntoSnapshot } from "./checkout-swap-view.ts";
import { requestSwapRefund } from "./swap-http.ts";

export class CheckoutWatcher {
  private options: CheckoutWatcherOptions;
  private state: CheckoutState | undefined;
  private snapshot: CheckoutSnapshot;
  /**
   * The swap attempt the payer is reviewing a refund for, held here because the
   * server does not know about it until they confirm: `/swaps/status` answers
   * without a `refund_address`, so a poll result would otherwise wipe what they
   * typed mid-review. Every snapshot this watcher publishes is folded through
   * it first, which is why no consumer has to remember an overlay rule.
   */
  private stagedSwapInvoice: CheckoutInvoiceSnapshot | undefined;

  /**
   * The host's order copy, remembered for the life of the checkout. It rides
   * `/checkouts/prepare` and `/checkouts` only — `/payments/check` has no
   * reason to re-send an unchanging display string on every tick — so without
   * this the first poll after the mint blanks it under the payer.
   */
  private description: string | undefined;
  private countdownTimer: ReturnType<typeof globalThis.setInterval> | undefined;
  private pollTimer: ReturnType<typeof globalThis.setInterval> | undefined;
  private running = false;
  private pollInFlight = false;
  private pollFailureCount = 0;
  private pollBackoffUntil: number | undefined;

  constructor(options: CheckoutWatcherOptions) {
    this.options = options;
    this.snapshot = options.snapshot;
  }

  start(): CheckoutState {
    this.stop();
    this.running = true;
    const snapshot = this.publishSnapshot(this.options.snapshot);
    const state = createCheckoutState(snapshot, {
      now: this.now(),
      logger: this.options.logger,
    });
    this.applyState(state);
    return state;
  }

  /** The last snapshot as the server gave it, before any staging overlay. */
  getSnapshot(): CheckoutSnapshot {
    return this.snapshot;
  }

  getStagedSwapInvoice(): CheckoutInvoiceSnapshot | undefined {
    return this.stagedSwapInvoice;
  }

  /**
   * Hold a swap attempt whose refund address the payer has staged, fold it into
   * the snapshot immediately, and republish. Passing `undefined` un-stages —
   * the "back to Lightning" exit and a fresh start both go through it.
   */
  stageSwapInvoice(invoice: CheckoutInvoiceSnapshot | undefined): CheckoutState | undefined {
    this.stagedSwapInvoice = invoice;
    const snapshot = this.publishSnapshot(this.snapshot);
    const current = this.state;
    const next = createCheckoutState(snapshot, {
      now: this.now(),
      logger: this.options.logger,
      source: "refresh",
      ...(current === undefined ? {} : { previousState: current }),
    });
    if (this.running) {
      this.applyState(next);
    } else {
      this.state = next;
    }
    return next;
  }

  /**
   * Fold the staged refund address back in and hand the result to `onSnapshot`,
   * so the host's copy and the derived state can never disagree about what the
   * payer is reviewing.
   *
   * What is REMEMBERED is the un-overlaid snapshot. Keeping the overlaid one
   * would bake the staged address into the record the next publish is computed
   * from, and un-staging could never take it back out.
   */
  private publishSnapshot(snapshot: CheckoutSnapshot): CheckoutSnapshot {
    const carried =
      snapshot.description === undefined && this.description !== undefined
        ? { ...snapshot, description: this.description }
        : snapshot;
    this.description = carried.description;
    this.snapshot = carried;
    const overlaid = overlaySwapRefundStagingIntoSnapshot(carried, this.stagedSwapInvoice);
    this.options.onSnapshot?.(overlaid);
    return overlaid;
  }

  stop(): void {
    this.running = false;
    this.stopCountdown();
    this.stopPolling();
  }

  getState(): CheckoutState | undefined {
    return this.state;
  }

  /**
   * Stop and enter the terminal `cancelled` phase. Unlike {@link stop}, the
   * watcher's own state moves, so later reads report `cancelled` instead of the
   * last polled state.
   */
  cancel(): CheckoutState {
    const current =
      this.state ??
      createCheckoutState(this.options.snapshot, {
        now: this.now(),
        logger: this.options.logger,
      });
    this.stop();
    // A settled attempt is already terminal and its money has moved: cancelling
    // it would only lie to the payer.
    if (current.settled) {
      this.state = current;
      return current;
    }
    const cancelled = normalizeCheckoutState(
      { ...current, workflow_state: "cancelled" },
      this.now(),
    );
    this.state = cancelled;
    this.options.onState(cancelled);
    return cancelled;
  }

  async reloadState(): Promise<CheckoutState> {
    const current =
      this.state ??
      createCheckoutState(this.options.snapshot, {
        now: this.now(),
        logger: this.options.logger,
      });
    const refreshStatus = this.options.refreshStatus;
    if (refreshStatus === undefined || current.reference.length === 0) {
      return current;
    }

    try {
      const fetched = await refreshStatus(current.reference);
      if (fetched === null) return current;
      const next = this.publishSnapshot(fetched);
      const nextState = createCheckoutState(next, {
        now: this.now(),
        logger: this.options.logger,
        source: "refresh",
        previousState: current,
      });
      if (this.running) {
        this.applyState(nextState);
      } else {
        this.state = nextState;
      }
      return nextState;
    } catch (error) {
      this.options.onError?.(error);
      throw error;
    }
  }

  private applyState(state: CheckoutState): void {
    if (!this.running) return;
    this.state = state;
    this.options.onState(state);
    this.syncWatchers();
  }

  private syncWatchers(): void {
    const state = this.state;
    if (state === undefined || !this.running) return;

    if (state.terminal) {
      this.stop();
      return;
    }

    if (state.settled || state.expires_at === undefined) {
      this.stopCountdown();
    } else if (this.countdownTimer === undefined) {
      this.countdownTimer = this.setInterval()(() => {
        const current = this.state;
        if (current === undefined) return;
        this.applyState(
          refreshCheckoutState(current, {
            now: this.now(),
            logger: this.options.logger,
            source: "countdown",
          }),
        );
      }, 1000);
    }

    const canPollAttempt =
      state.rail !== "checkout_lock" &&
      typeof state.payment_hash === "string" &&
      /^[0-9a-f]{64}$/i.test(state.payment_hash);
    if (
      state.settled ||
      this.options.refreshStatus === undefined ||
      state.reference.length === 0 ||
      !canPollAttempt
    ) {
      this.stopPolling();
    } else if (this.pollTimer === undefined) {
      this.pollTimer = this.setInterval()(() => {
        void this.poll();
      }, this.options.pollIntervalMs ?? OPENRECEIVE_DEFAULT_POLL_INTERVAL_MS);
    }
  }

  private async poll(): Promise<void> {
    const refreshStatus = this.options.refreshStatus;
    const current = this.state;
    if (!this.running || refreshStatus === undefined || current === undefined) return;
    if (current.terminal || current.settled) {
      this.stopPolling();
      return;
    }
    // One request at a time: a slow backend must not stack overlapping polls
    // (which multiply load exactly when it is struggling, and whose stale
    // responses could arrive out of order).
    if (this.pollInFlight) return;
    // Failed polls back off (honoring the server's Retry-After when present)
    // instead of hammering at the fixed interval.
    if (this.pollBackoffUntil !== undefined && this.now() < this.pollBackoffUntil) return;
    this.pollInFlight = true;

    try {
      const fetched = await refreshStatus(current.reference);
      this.pollFailureCount = 0;
      this.pollBackoffUntil = undefined;
      if (fetched === null) return;
      if (!this.running || this.state === undefined) return;
      // A response that raced a settlement must never flip a paid screen
      // back to "waiting for payment".
      if (this.state.settled || this.state.terminal) return;
      const next = this.publishSnapshot(fetched);
      this.applyState(
        createCheckoutState(next, {
          now: this.now(),
          logger: this.options.logger,
          source: "refresh",
          previousState: this.state,
        }),
      );
    } catch (error) {
      this.pollFailureCount += 1;
      const retryAfterSeconds =
        error instanceof BrowserRequestError ? error.retryAfterSeconds : undefined;
      const backoffSeconds =
        retryAfterSeconds ?? Math.min(60, 2 ** Math.min(this.pollFailureCount, 6));
      this.pollBackoffUntil = this.now() + backoffSeconds;
      this.options.onError?.(error);
    } finally {
      this.pollInFlight = false;
    }
  }

  private stopCountdown(): void {
    if (this.countdownTimer === undefined) return;
    this.clearInterval()(this.countdownTimer);
    this.countdownTimer = undefined;
  }

  private stopPolling(): void {
    if (this.pollTimer === undefined) return;
    this.clearInterval()(this.pollTimer);
    this.pollTimer = undefined;
  }

  private now(): number {
    return this.options.now?.() ?? unixSeconds();
  }

  private setInterval(): typeof globalThis.setInterval {
    return this.options.setInterval ?? globalThis.setInterval;
  }

  private clearInterval(): typeof globalThis.clearInterval {
    return this.options.clearInterval ?? globalThis.clearInterval;
  }
}

export class BrowserCheckoutController implements CheckoutController {
  private options: CheckoutControllerOptions;
  private watcher: CheckoutWatcher;
  private state: CheckoutState | undefined;

  constructor(options: CheckoutControllerOptions) {
    this.options = options;
    this.watcher = this.createWatcher(options);
  }

  start(): CheckoutState {
    this.state = this.watcher.start();
    return this.state;
  }

  stop(): void {
    this.watcher.stop();
  }

  getState(): CheckoutState | undefined {
    // The watcher owns state. A stopped watcher still applies reloadState()
    // results to itself without calling back, so preferring the controller's
    // last observed copy would serve a stale state after stop().
    return this.watcher.getState() ?? this.state;
  }

  async copyInvoice(): Promise<void> {
    const state = this.currentState();
    await copyInvoice({
      invoice: state.invoice,
      clipboard: this.options.clipboard,
      logger: this.options.logger,
      logContext: checkoutLogFields(state),
    });
  }

  openWallet(): string {
    const state = this.currentState();
    return openWallet({
      invoice: state.invoice,
      open: this.options.open,
      logger: this.options.logger,
      logContext: checkoutLogFields(state),
    });
  }

  async reloadState(): Promise<CheckoutState> {
    return this.watcher.reloadState();
  }

  /**
   * Step one of the two-step refund: post `/swaps/status` and hold the address
   * the payer typed, so the panel can show it back for confirmation. It touches
   * no refund route — nothing is submitted until {@link confirmSwapRefund}.
   *
   * The staged address lives in the watcher, so every later poll keeps it.
   */
  async stageSwapRefund(options: {
    readonly attemptId: string;
    readonly refundAddress: string;
  }): Promise<CheckoutInvoiceSnapshot> {
    return this.submitSwapRefund(options, false);
  }

  /** Step two: the only call that posts `/swaps/refunds`. */
  async confirmSwapRefund(options: {
    readonly attemptId: string;
    readonly refundAddress: string;
  }): Promise<CheckoutInvoiceSnapshot> {
    return this.submitSwapRefund(options, true);
  }

  /**
   * Drop the staged address. The payer leaving the swap for Lightning is the
   * one exit that is not a submitted refund, so the engine owns clearing it.
   */
  clearSwapRefundStaging(): void {
    if (this.watcher.getStagedSwapInvoice() === undefined) return;
    this.watcher.stageSwapInvoice(undefined);
  }

  private async submitSwapRefund(
    options: { readonly attemptId: string; readonly refundAddress: string },
    confirm: boolean,
  ): Promise<CheckoutInvoiceSnapshot> {
    const prefix = this.options.prefix;
    if (prefix === undefined) {
      throw new TypeError("Swap refunds need the mount prefix the controller was given.");
    }
    const snapshot = this.watcher.getSnapshot();
    // The controller holds the snapshot, so it resolves the attempt's payment
    // hash itself — the route takes a hash, and an integration should not have
    // to hand back an invoice array to look one up.
    const paymentHash = resolveAttemptPaymentHash(
      [this.watcher.getStagedSwapInvoice(), ...snapshot.invoices],
      options.attemptId,
    );
    if (paymentHash === undefined) {
      throw new Error(`No swap attempt ${options.attemptId} in this checkout.`);
    }
    const invoice = await requestSwapRefund({
      fetch: this.options.fetch ?? globalThis.fetch,
      prefix,
      ...(snapshot.reference === "" ? {} : { reference: snapshot.reference }),
      ...(this.options.statusHeaders === undefined ? {} : { headers: this.options.statusHeaders }),
      ...(this.options.logger === undefined ? {} : { logger: this.options.logger }),
      paymentHash,
      refundAddress: options.refundAddress,
      confirm,
    });
    this.watcher.stageSwapInvoice(invoice);
    return invoice;
  }

  cancel(): CheckoutState {
    this.state = this.watcher.cancel();
    emitBrowserLog(
      this.options.logger,
      "info",
      "checkout.cancelled",
      "Cancelled checkout and stopped the watcher.",
      checkoutLogFields(this.state),
    );
    return this.state;
  }

  private createWatcher(options: CheckoutControllerOptions): CheckoutWatcher {
    // `polling: false` withholds the status fetcher, NOT the mount: `prefix`
    // still says where the routes are, so a refund can be staged on a checkout
    // that is deliberately not polling.
    const refreshStatus =
      options.polling === false
        ? undefined
        : (options.refreshStatus ??
          (options.prefix === undefined
            ? undefined
            : createStatusFetcher({
                prefix: options.prefix,
                snapshot: options.snapshot,
                fetch: options.fetch,
                headers: options.statusHeaders,
              })));

    return new CheckoutWatcher({
      ...options,
      ...(refreshStatus === undefined ? {} : { refreshStatus }),
      onState: (state) => {
        this.state = state;
        options.onState?.(state);
      },
      ...(options.onSnapshot === undefined ? {} : { onSnapshot: options.onSnapshot }),
    });
  }

  private currentState(): CheckoutState {
    return (
      this.getState() ??
      createCheckoutState(this.options.snapshot, {
        now: this.options.now?.(),
        logger: this.options.logger,
      })
    );
  }
}

export function createCheckoutController(options: CheckoutControllerOptions): CheckoutController {
  return new BrowserCheckoutController(options);
}

/**
 * An attempt is addressed by `swap.attempt_id ?? invoice_id` everywhere the
 * payer can see it (that is what `SwapDisplayModel.attemptId` is), and the
 * routes take `payment_hash`. This is the one place that translation happens.
 */
function resolveAttemptPaymentHash(
  invoices: readonly (CheckoutInvoiceSnapshot | undefined)[],
  attemptId: string,
): string | undefined {
  for (const invoice of invoices) {
    if (invoice === undefined) continue;
    if ((invoice.swap?.attempt_id ?? invoice.invoice_id) !== attemptId) continue;
    if (invoice.payment_hash !== undefined) return invoice.payment_hash;
  }
  return undefined;
}
