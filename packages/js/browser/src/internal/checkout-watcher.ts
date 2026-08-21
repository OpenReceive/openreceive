// The polling loop and the controller around it: CheckoutWatcher owns the
// interval, the terminal-state stop rules and the subscriber list;
// OpenReceiveBrowserCheckoutController is the object the UI packages drive.

import { unixSeconds } from "@openreceive/core";
import {
  type CheckoutController,
  type CheckoutControllerOptions,
  type CheckoutState,
  type CheckoutWatcherOptions,
  OPENRECEIVE_DEFAULT_POLL_INTERVAL_MS,
} from "./ui.ts";
import { checkoutLogFields, emitBrowserLog } from "./checkout-log.ts";
import {
  createOpenReceiveStatusFetcher,
  OpenReceiveBrowserRequestError,
} from "./checkout-transport.ts";
import {
  createCheckoutState,
  normalizeCheckoutState,
  refreshCheckoutState,
} from "./checkout-state.ts";
import { copyInvoice, openWallet } from "./checkout-actions.ts";

export class CheckoutWatcher {
  private options: CheckoutWatcherOptions;
  private state: CheckoutState | undefined;
  private countdownTimer: ReturnType<typeof globalThis.setInterval> | undefined;
  private pollTimer: ReturnType<typeof globalThis.setInterval> | undefined;
  private running = false;
  private pollInFlight = false;
  private pollFailureCount = 0;
  private pollBackoffUntil: number | undefined;

  constructor(options: CheckoutWatcherOptions) {
    this.options = options;
  }

  start(): CheckoutState {
    this.stop();
    this.running = true;
    this.options.onSnapshot?.(this.options.snapshot);
    const state = createCheckoutState(this.options.snapshot, {
      now: this.now(),
      logger: this.options.logger,
    });
    this.applyState(state);
    return state;
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
    if (refreshStatus === undefined || current.order_id.length === 0) {
      return current;
    }

    try {
      const next = await refreshStatus(current.order_id);
      if (next === null) return current;
      this.options.onSnapshot?.(next);
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
      state.order_id.length === 0 ||
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
      const next = await refreshStatus(current.order_id);
      this.pollFailureCount = 0;
      this.pollBackoffUntil = undefined;
      if (next === null) return;
      if (!this.running || this.state === undefined) return;
      // A response that raced a settlement must never flip a paid screen
      // back to "waiting for payment".
      if (this.state.settled || this.state.terminal) return;
      this.options.onSnapshot?.(next);
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
        error instanceof OpenReceiveBrowserRequestError ? error.retryAfterSeconds : undefined;
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

export class OpenReceiveBrowserCheckoutController implements CheckoutController {
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
    const refreshStatus =
      options.refreshStatus ??
      (options.orderUrl === undefined
        ? undefined
        : createOpenReceiveStatusFetcher({
            orderUrl: options.orderUrl,
            snapshot: options.snapshot,
            fetch: options.fetch,
            headers: options.statusHeaders,
          }));

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
  return new OpenReceiveBrowserCheckoutController(options);
}
