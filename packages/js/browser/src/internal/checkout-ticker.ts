// Two small timer-driven value controllers the checkout UI shares: transient
// feedback ("Copied!" reverting itself) and a value that re-derives on a tick
// (the expiry countdown). Both are DOM-free so React, the custom element and
// the headless engine can all drive them.

import { unixSeconds } from "@openreceive/core";
import {
  OPENRECEIVE_COPY_FEEDBACK_MS,
  type TickingValueController,
  type TickingValueOptions,
  type TransientFeedbackController,
  type TransientFeedbackOptions,
} from "./ui.ts";

export function createTransientFeedbackController<T>(
  options: TransientFeedbackOptions<T>,
): TransientFeedbackController<T> {
  const delayMs = options.delayMs ?? OPENRECEIVE_COPY_FEEDBACK_MS;
  const setTimeoutFn = options.setTimeout ?? globalThis.setTimeout;
  const clearTimeoutFn = options.clearTimeout ?? globalThis.clearTimeout;
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;

  const clear = (): void => {
    if (timeout === undefined) return;
    clearTimeoutFn(timeout);
    timeout = undefined;
  };

  return {
    show(value: T): void {
      clear();
      options.onValue(value);
      timeout = setTimeoutFn(() => {
        timeout = undefined;
        options.onValue(options.resetValue);
      }, delayMs);
    },
    clear,
  };
}

export function createTickingValueController(options: TickingValueOptions): TickingValueController {
  const intervalMs = options.intervalMs ?? 1000;
  const now = options.now ?? unixSeconds;
  const setIntervalFn = options.setInterval ?? globalThis.setInterval;
  const clearIntervalFn = options.clearInterval ?? globalThis.clearInterval;
  let timer: ReturnType<typeof globalThis.setInterval> | undefined;

  const refresh = (): void => {
    options.onValue(now());
  };

  const stop = (): void => {
    if (timer === undefined) return;
    clearIntervalFn(timer);
    timer = undefined;
  };

  return {
    start(): void {
      stop();
      if (options.active === false) return;
      refresh();
      timer = setIntervalFn(refresh, intervalMs);
    },
    stop,
    refresh,
  };
}
