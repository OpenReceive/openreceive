import type { InvoiceStorageRow } from "@openreceive/core";
import type { NwcEndpointLogger } from "../alby-nwc.ts";
import { isRecord } from "./core-utils.ts";
import type {
  CreateOpenReceiveOptions,
  OpenReceiveEvent,
  OpenReceiveEventHandler,
  OpenReceiveLogger,
  OpenReceiveLogLevel,
  OpenReceiveNodeOptions,
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

export function emitLog(
  options: OpenReceiveNodeOptions,
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
    readonly onEvent?: OpenReceiveEventHandler;
    readonly logger?: OpenReceiveLogger;
  },
  event: OpenReceiveEvent,
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

export function sanitizeOpenReceiveEvent(entry: OpenReceiveEvent): OpenReceiveEvent {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (isSensitiveLogKey(key)) {
      clean[key] = "[REDACTED]";
    } else {
      clean[key] = sanitizeLogValue(value);
    }
  }
  return clean as OpenReceiveEvent;
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
  return /secret|token|authorization|cookie|nwc/i.test(key);
}

export function redactSecrets(value: string): string {
  return value
    .replace(/nostr\+walletconnect:\/\/[^\s"'`<>]+/g, "[REDACTED_NWC]")
    .replace(/([?&](?:token|secret)=)[^&\s"'`<>]+/gi, "$1[REDACTED]");
}
