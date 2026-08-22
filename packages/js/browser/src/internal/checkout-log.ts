// The browser checkout's audit log: which fields of a checkout state and of a
// swap attempt may reach a log sink, and the emitter that sanitizes and
// forwards them. The field lists here are an allowlist — see the note on
// `swapAuditLogFields`.

import { compact } from "@openreceive/core";
import { resolveOpenReceiveBrowserLogger, sanitizeBrowserLogEntry } from "./console-logger.ts";
import type {
  CheckoutState,
  OpenReceiveBrowserLoggerOption,
  OpenReceiveBrowserLogLevel,
} from "./ui.ts";
import { getOpenReceiveSwapProviderStateLabel } from "./checkout-swap-view.ts";

/** The swap fields the checkout audit log is allowed to see. */
interface SwapAuditLogSource {
  readonly attempt_id?: string;
  readonly provider?: string;
  readonly provider_order_id?: string;
  readonly pay_in_asset?: string;
  readonly provider_state?: string;
  readonly attention?: boolean;
  readonly attention_reason?: string;
  readonly refund_reason?: string;
  readonly refund_nonce?: string;
  readonly refund_nonce_expires_at?: number;
  readonly refund_tx_id?: string;
  readonly deposit_tx_id?: string;
  readonly payout_tx_id?: string;
}

export function checkoutLogFields(state: {
  readonly checkout_id?: string;
  readonly order_id?: string;
  readonly invoice_id?: string;
  readonly payment_hash?: string;
  readonly amount_msats?: number;
  readonly transaction_state?: string;
  readonly workflow_state?: string;
  readonly phase?: string;
  readonly expires_in_seconds?: number;
  readonly settled?: boolean;
  readonly paid?: boolean;
  readonly rail?: string;
  readonly swap?: SwapAuditLogSource;
}): Record<string, unknown> {
  return compact({
    checkout_id: state.checkout_id,
    order_id: state.order_id,
    invoice_id: state.invoice_id,
    payment_hash: state.payment_hash,
    amount_msats: state.amount_msats,
    transaction_state: state.transaction_state,
    workflow_state: state.workflow_state,
    phase: state.phase,
    expires_in_seconds: state.expires_in_seconds,
    settled: state.settled,
    paid: state.paid,
    rail: state.rail,
    ...swapAuditLogFields(state.swap),
  });
}

/**
 * This list is an ALLOWLIST, not a redaction pass: whatever is named here
 * reaches a log sink verbatim. `refund_nonce_present` is deliberate — the
 * nonce authorizes a refund payout, so only its presence may be logged, never
 * its value, and the same goes for the preimage and the raw bolt11.
 * tests/browser-checkout-controller.test.mjs holds that line.
 */
function swapAuditLogFields(swap: SwapAuditLogSource | undefined): Record<string, unknown> {
  if (swap === undefined) return {};
  return compact({
    attempt_id: swap.attempt_id,
    provider: swap.provider,
    provider_order_id: swap.provider_order_id,
    pay_in_asset: swap.pay_in_asset,
    provider_state: swap.provider_state,
    attention: swap.attention,
    attention_reason: swap.attention_reason,
    refund_reason: swap.refund_reason,
    refund_nonce_present: swap.refund_nonce !== undefined,
    refund_nonce_expires_at: swap.refund_nonce_expires_at,
    refund_tx_id: swap.refund_tx_id,
    deposit_tx_id: swap.deposit_tx_id,
    payout_tx_id: swap.payout_tx_id,
  });
}

export function emitBrowserSwapTransition(
  logger: OpenReceiveBrowserLoggerOption | undefined,
  previous: CheckoutState | undefined,
  next: CheckoutState,
): void {
  const previousSwap = previous?.swap;
  const nextSwap = next.swap;
  if (nextSwap === undefined) return;

  const previousState = previousSwap?.provider_state;
  const nextState = nextSwap.provider_state;
  const previousNonce = previousSwap?.refund_nonce !== undefined;
  const nextNonce = nextSwap.refund_nonce !== undefined;
  const previousAttention = previousSwap?.attention_reason;
  const nextAttention = nextSwap.attention_reason;
  const previousSettled = previous?.settled === true || previous?.paid === true;
  const nextSettled = next.settled === true || next.paid === true;

  const stateChanged = previousState !== nextState;
  const nonceChanged = previousNonce !== nextNonce;
  const attentionChanged = previousAttention !== nextAttention;
  const settlementChanged = previousSettled !== nextSettled;
  if (!stateChanged && !nonceChanged && !attentionChanged && !settlementChanged) return;

  const level: OpenReceiveBrowserLogLevel =
    nextState === "attention" || nextSwap.attention === true
      ? "warn"
      : nextState === "refund_required" ||
          nextState === "refund_pending" ||
          nextState === "refunded" ||
          nextState === "failed" ||
          nextState === "expired" ||
          settlementChanged
        ? "info"
        : "debug";

  emitBrowserLog(
    logger,
    level,
    "swap.state.changed",
    "Swap attempt state changed in checkout UI.",
    {
      ...checkoutLogFields(next),
      previous_provider_state: previousState,
      previous_settled: previousSettled,
      wallet_settled: nextSettled,
      ui_label: nextSettled ? "Payment complete" : getOpenReceiveSwapProviderStateLabel(nextState),
    },
  );
}

export function emitBrowserLog(
  logger: OpenReceiveBrowserLoggerOption | undefined,
  level: OpenReceiveBrowserLogLevel,
  event: string,
  message: string,
  fields: Record<string, unknown> = {},
): void {
  const sink = resolveOpenReceiveBrowserLogger(logger);
  if (sink === undefined) return;

  try {
    sink(
      sanitizeBrowserLogEntry({
        level,
        event,
        message,
        ...fields,
      }),
    );
  } catch {
    // Checkout logs are diagnostic only and must not affect user actions.
  }
}
