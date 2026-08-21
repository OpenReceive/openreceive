import { compact, isRecord } from "@openreceive/core";
import type { NwcEndpointLogger } from "../alby-nwc.ts";
import type {
  CreateOpenReceiveOptions,
  EventHandler,
  Logger,
  NodeOptions,
  OpenReceiveLogEvent,
  OpenReceiveLogLevel,
} from "./types.ts";

export function emitLog(
  options: NodeOptions,
  level: OpenReceiveLogLevel,
  event: string,
  message: string,
  fields: Record<string, unknown> = {},
): void {
  emitOpenReceiveEvent(options, {
    level,
    event,
    message,
    ...fields,
  });
}

export function emitOpenReceiveEvent(
  options: {
    readonly onEvent?: EventHandler;
    readonly logger?: Logger;
  },
  event: OpenReceiveLogEvent,
): void {
  if (options.onEvent === undefined && options.logger === undefined) return;

  const sanitized = sanitizeOpenReceiveEvent(event);

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
  return (entry) => emitOpenReceiveEvent(options, entry);
}

export function sanitizeOpenReceiveEvent(entry: OpenReceiveLogEvent): OpenReceiveLogEvent {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (isSensitiveLogKey(key)) {
      clean[key] = "[REDACTED]";
    } else {
      clean[key] = sanitizeLogValue(value);
    }
  }
  return clean as OpenReceiveLogEvent;
}

export function sanitizeLogValue(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(sanitizeLogValue);
  if (typeof value !== "object" || value === null) return value;

  const clean: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (isSensitiveLogKey(key)) {
      clean[key] = "[REDACTED]";
    } else {
      clean[key] = sanitizeLogValue(nested);
    }
  }
  return clean;
}

/**
 * Field names whose VALUE never belongs in a log line, whatever it holds:
 * wallet and provider credentials, the settlement preimage (proof of payment),
 * the raw invoice (`bolt11` payloads carried inside provider errors), and the
 * server-only swap recovery blob (`swap_data` holds the provider order token).
 */
export function isSensitiveLogKey(key: string): boolean {
  // `*_present` fields are deliberate presence flags (`preimage_present`) — the
  // safe thing to log instead of the value.
  if (/_present$/i.test(key)) return false;
  return /secret|token|authorization|cookie|nwc|dsn|preimage|invoice|bolt11|swap_?data|(?:private|api)[_-]?key|^key$|api[_-]?sign/i.test(
    key,
  );
}

export function redactSecrets(value: string): string {
  return (
    value
      .replace(/nostr\+walletconnect:\/\/[^\s"'`<>]+/g, "[REDACTED_NWC]")
      // Lightning Swap Connect credential URI: host, key, and secret in one string.
      .replace(/lightning\+swapconnect:\/\/[^\s"'`<>]+/g, "[REDACTED_LSC]")
      // `key=` is half an LSC credential pair on its own, so it is redacted
      // wherever it appears in a query string, not only inside a full URI.
      .replace(/([?&](?:token|secret|key)=)[^&\s"'`<>]+/gi, "$1[REDACTED]")
  );
}

/**
 * Compact fields for swap.provider.request — order ids / path only, never full
 * bodies (tokens, bolt11, etc.).
 */
export function summarizeSwapProviderApiRequest(entry: {
  readonly provider: string;
  readonly path: string;
  readonly body: unknown;
}): Record<string, unknown> {
  const body = isRecord(entry.body) ? entry.body : undefined;
  return compact({
    provider: entry.provider,
    path: entry.path,
    order_id: optionalLogString(body?.id),
    choice: optionalLogString(body?.choice),
    from_ccy: optionalLogString(body?.fromCcy),
    to_ccy: optionalLogString(body?.toCcy),
    amount: optionalLogString(body?.amount) ?? optionalLogNumber(body?.amount),
  });
}

/**
 * Compact fields for swap.provider.response — status + a short order/quote
 * summary instead of the full FixedFloat envelope (bolt11, addresses, nested tx).
 */
export function summarizeSwapProviderApiResponse(entry: {
  readonly provider: string;
  readonly path: string;
  readonly status: number;
  readonly ok: boolean;
  readonly code: unknown;
  readonly msg: unknown;
  readonly data: unknown;
}): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    provider: entry.provider,
    path: entry.path,
    status: entry.status,
    ok: entry.ok,
  };
  if (entry.code !== undefined && entry.code !== null) summary.code = entry.code;
  const msg = optionalLogString(entry.msg);
  if (msg !== undefined && msg !== "OK") summary.msg = msg;

  const data = entry.data;
  if (Array.isArray(data)) {
    summary.items = data.length;
    return summary;
  }
  if (!isRecord(data)) return summary;

  const pairCount = optionalLogNumber(data.pair_count);
  if (pairCount !== undefined) {
    summary.pair_count = pairCount;
    return summary;
  }

  const orderId = optionalLogString(data.id);
  const orderStatus = optionalLogString(data.status);
  if (orderId !== undefined) summary.order_id = orderId;
  if (orderStatus !== undefined) summary.order_status = orderStatus;

  const from = summarizeSwapProviderSide(data.from);
  const to = summarizeSwapProviderSide(data.to);
  if (from !== undefined) summary.from = from;
  if (to !== undefined) summary.to = to;

  if (isRecord(data.time)) {
    const left = optionalLogNumber(data.time.left);
    if (left !== undefined) summary.left = left;
  }

  if (isRecord(data.emergency)) {
    const choice = optionalLogString(data.emergency.choice);
    if (choice !== undefined && choice !== "NONE") summary.emergency = choice;
    const statuses = Array.isArray(data.emergency.status)
      ? data.emergency.status
          .filter((item): item is string => typeof item === "string" && item.length > 0)
          .map((item) => item.toUpperCase())
      : [];
    if (statuses.length > 0) summary.emergency_status = statuses.join(",");
    const repeat = data.emergency.repeat;
    if (repeat === true || repeat === "1" || repeat === 1) summary.emergency_repeat = true;
  }

  if (isRecord(data.from) && isRecord(data.from.tx)) {
    const received = optionalLogString(data.from.tx.amount);
    if (received !== undefined) summary.deposit_received = received;
  }
  if (isRecord(data.back)) {
    const refundAmount = optionalLogString(data.back.amount);
    if (refundAmount !== undefined) summary.refund_amount = refundAmount;
  }

  // /price quotes carry from/to amounts without an order id.
  if (orderId === undefined) {
    const fromRecord = isRecord(data.from) ? data.from : undefined;
    const toRecord = isRecord(data.to) ? data.to : undefined;
    const fromAmount = optionalLogString(fromRecord?.amount) ?? optionalLogString(data.fromAmount);
    const toAmount = optionalLogString(toRecord?.amount) ?? optionalLogString(data.toAmount);
    if (fromAmount !== undefined) summary.from_amount = fromAmount;
    if (toAmount !== undefined) summary.to_amount = toAmount;
  }

  return summary;
}

function summarizeSwapProviderSide(side: unknown): string | undefined {
  if (!isRecord(side)) return undefined;
  const code = optionalLogString(side.code) ?? optionalLogString(side.coin);
  const amount = optionalLogString(side.amount);
  if (code === undefined && amount === undefined) return undefined;
  if (code !== undefined && amount !== undefined) return `${code} ${amount}`;
  return code ?? amount;
}

function optionalLogString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalLogNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
