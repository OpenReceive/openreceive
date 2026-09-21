import type { SwapProviderApiRequestLog, SwapProviderApiResponseLog } from "../swap/provider.ts";
import { isSensitiveLogKey, sanitizeLogValue } from "@openreceive/core";
import type { NwcEndpointLogger } from "../alby-nwc.ts";
import type {
  CreateOpenReceiveOptions,
  EventHandler,
  LogEvent,
  Logger,
  LogLevel,
  NodeOptions,
} from "./types.ts";

export function emitLog(
  options: NodeOptions,
  level: LogLevel,
  event: string,
  message: string,
  fields: Record<string, unknown> = {},
): void {
  emitEvent(options, {
    level,
    event,
    message,
    ...fields,
  });
}

export function emitEvent(
  options: {
    readonly onEvent?: EventHandler;
    readonly logger?: Logger;
  },
  event: LogEvent,
): void {
  if (options.onEvent === undefined && options.logger === undefined) return;

  const sanitized = sanitizeEvent(event);

  try {
    options.onEvent?.(sanitized);
  } catch {
    // Diagnostics must never change payment, settlement, or settlement-action behavior.
  }

  try {
    options.logger?.(sanitized);
  } catch {
    // Logging must never change payment, settlement, or settlement-action behavior.
  }
}

// Bridges the receive client's NWC endpoint hits (get_info / make_invoice /
// list_transactions) into the service's onEvent + logger sinks, reusing the
// same sanitization so secrets never reach a log line. Returns undefined when
// no sink is configured so the client can skip building entries entirely.
export function createNwcEndpointLogger(
  options: CreateOpenReceiveOptions,
): NwcEndpointLogger | undefined {
  if (options.onEvent === undefined && options.logger === undefined) return undefined;
  return (entry) => emitEvent(options, entry);
}

/**
 * The message of `payment.reconcile.completed`: what the pass decided, in a
 * few words — "1 pending", "1 settled, 2 pending", "3 pending of 4 attempts"
 * when the walk could not reach every hash (a truncated scan). Zero counts
 * stay out; this line prints on every status poll while a payer waits.
 */
export function summarizeReconcilePass(input: {
  readonly attemptCount: number;
  readonly resultCount: number;
  readonly settledCount: number;
  readonly pendingCount: number;
  readonly notFoundCount: number;
}): string {
  const decided = [
    [input.settledCount, "settled"],
    [input.pendingCount, "pending"],
    [input.notFoundCount, "not found"],
  ]
    .filter(([count]) => (count as number) > 0)
    .map(([count, label]) => `${count} ${label}`);
  const summary = decided.length === 0 ? "0 decided" : decided.join(", ");
  const attempts = `${input.attemptCount} ${input.attemptCount === 1 ? "attempt" : "attempts"}`;
  return input.resultCount === input.attemptCount ? summary : `${summary} of ${attempts}`;
}

export function sanitizeEvent(entry: LogEvent): LogEvent {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (isSensitiveLogKey(key)) {
      clean[key] = "[REDACTED]";
    } else {
      clean[key] = sanitizeLogValue(value);
    }
  }
  return clean as LogEvent;
}

/** Copy only the diagnostic contract, including for custom providers. */
export function summarizeSwapProviderApiRequest(
  entry: SwapProviderApiRequestLog,
): Record<string, unknown> {
  return {
    provider: entry.provider,
    path: entry.path,
    has_body: entry.has_body,
    has_token: entry.has_token,
  };
}

export function summarizeSwapProviderApiResponse(
  entry: SwapProviderApiResponseLog,
): Record<string, unknown> {
  return {
    provider: entry.provider,
    path: entry.path,
    status: entry.status,
    ok: entry.ok,
    code: entry.code,
    has_data: entry.has_data,
    items: entry.items,
    pair_count: entry.pair_count,
  };
}

export { isSensitiveLogKey, redactSecrets } from "@openreceive/core";
