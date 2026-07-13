import type { OpenReceive } from "./service/types.ts";

export interface StartSweeperOptions {
  /** How often to call `sweepPendingInvoices`. Defaults to 3000ms. */
  readonly intervalMs?: number;
}

export interface SweeperHandle {
  /** Clear the interval. Safe to call more than once. */
  stop(): void;
}

/**
 * Opt-in background settlement driver for long-lived Node processes.
 *
 * Organic traffic already advances the global sweep cursor on checkout create and
 * order status reads, so idle systems are the main reason to run this. Do NOT use
 * it as an adapter default — serverless / Next have no long-lived process, and
 * active sites do not need the extra DB/wallet load.
 *
 * Keep it out of the quickstart happy path; see docs/internal/settlement-sweeps.md.
 */
export function startSweeper(
  service: Pick<OpenReceive, "sweepPendingInvoices">,
  options: StartSweeperOptions = {},
): SweeperHandle {
  const intervalMs = options.intervalMs ?? 3000;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new TypeError("startSweeper intervalMs must be a positive number.");
  }

  const timer = setInterval(() => {
    void service.sweepPendingInvoices();
  }, intervalMs);
  // Don't keep the process alive solely for the sweeper.
  timer.unref?.();

  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}
