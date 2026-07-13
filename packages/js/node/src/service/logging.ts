import type { InvoiceStorageRow } from "@openreceive/core";
import type { NwcEndpointLogger } from "../alby-nwc.ts";
import { isRecord } from "./core-utils.ts";
import type {
  CreateOpenReceiveOptions,
  Event,
  EventHandler,
  Logger,
  OpenReceiveLogLevel,
  NodeOptions,
} from "./types.ts";

export function invoiceLogFields(row: InvoiceStorageRow): Record<string, unknown> {
  return {
    invoice_id: row.invoice_id,
    payment_hash: row.payment_hash,
    amount_msats: row.amount_msats,
    transaction_state: row.transaction_state,
    workflow_state: row.workflow_state,
    settlement_action_state: row.settlement_action_state,
    ...(row.settled_at === undefined ? {} : { settled_at: row.settled_at }),
    ...(row.settlement_action_completed_at === undefined
      ? {}
      : { settlement_action_completed_at: row.settlement_action_completed_at }),
    ...(row.refreshed_from_invoice_id === undefined
      ? {}
      : { refreshed_from_invoice_id: row.refreshed_from_invoice_id }),
  };
}

/** Audit fields for swap attempt transitions — never includes refund_nonce or addresses. */
export function swapAttemptLogFields(input: {
  readonly invoice_id?: string;
  readonly order_id?: string;
  readonly provider?: string;
  readonly provider_order_id?: string;
  readonly pay_in_asset?: string;
  readonly previous_state?: string;
  readonly provider_state?: string;
  readonly attention?: boolean;
  readonly attention_reason?: string;
  readonly refund_reason?: string;
  readonly refund_nonce_present?: boolean;
  readonly refund_nonce_expires_at?: number;
  readonly refund_tx_id?: string;
  readonly deposit_tx_id?: string;
  readonly payout_tx_id?: string;
  readonly transaction_state?: string;
  readonly settled_at?: number;
}): Record<string, unknown> {
  return {
    ...(input.invoice_id === undefined ? {} : { invoice_id: input.invoice_id }),
    ...(input.order_id === undefined ? {} : { order_id: input.order_id }),
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    ...(input.provider_order_id === undefined
      ? {}
      : { provider_order_id: input.provider_order_id }),
    ...(input.pay_in_asset === undefined ? {} : { pay_in_asset: input.pay_in_asset }),
    ...(input.previous_state === undefined ? {} : { previous_state: input.previous_state }),
    ...(input.provider_state === undefined ? {} : { provider_state: input.provider_state }),
    ...(input.attention === undefined ? {} : { attention: input.attention }),
    ...(input.attention_reason === undefined
      ? {}
      : { attention_reason: input.attention_reason }),
    ...(input.refund_reason === undefined ? {} : { refund_reason: input.refund_reason }),
    ...(input.refund_nonce_present === undefined
      ? {}
      : { refund_nonce_present: input.refund_nonce_present }),
    ...(input.refund_nonce_expires_at === undefined
      ? {}
      : { refund_nonce_expires_at: input.refund_nonce_expires_at }),
    ...(input.refund_tx_id === undefined ? {} : { refund_tx_id: input.refund_tx_id }),
    ...(input.deposit_tx_id === undefined ? {} : { deposit_tx_id: input.deposit_tx_id }),
    ...(input.payout_tx_id === undefined ? {} : { payout_tx_id: input.payout_tx_id }),
    ...(input.transaction_state === undefined
      ? {}
      : { transaction_state: input.transaction_state }),
    ...(input.settled_at === undefined ? {} : { settled_at: input.settled_at }),
  };
}

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
  event: Event,
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

export function sanitizeOpenReceiveEvent(entry: Event): Event {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (isSensitiveLogKey(key)) {
      clean[key] = "[REDACTED]";
    } else {
      clean[key] = sanitizeLogValue(value);
    }
  }
  return clean as Event;
}

export function publicSettlementMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const clean = structuredClone(metadata);
  delete clean.swap_private;
  if (isRecord(clean.swap)) {
    const swap = { ...clean.swap };
    delete swap.provider_token;
    clean.swap = swap;
  }
  return clean;
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

export function isSensitiveLogKey(key: string): boolean {
  return /secret|token|authorization|cookie|nwc|dsn/i.test(key);
}

export function redactSecrets(value: string): string {
  return value
    .replace(/nostr\+walletconnect:\/\/[^\s"'`<>]+/g, "[REDACTED_NWC]")
    .replace(/([?&](?:token|secret)=)[^&\s"'`<>]+/gi, "$1[REDACTED]");
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
  const orderId = optionalLogString(body?.id);
  const choice = optionalLogString(body?.choice);
  const fromCcy = optionalLogString(body?.fromCcy);
  const toCcy = optionalLogString(body?.toCcy);
  const amount = optionalLogString(body?.amount) ?? optionalLogNumber(body?.amount);
  return {
    provider: entry.provider,
    path: entry.path,
    ...(orderId === undefined ? {} : { order_id: orderId }),
    ...(choice === undefined ? {} : { choice }),
    ...(fromCcy === undefined ? {} : { from_ccy: fromCcy }),
    ...(toCcy === undefined ? {} : { to_ccy: toCcy }),
    ...(amount === undefined ? {} : { amount }),
  };
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
    const fromAmount =
      optionalLogString(fromRecord?.amount) ?? optionalLogString(data.fromAmount);
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
