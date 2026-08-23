/**
 * FixedFloat order bodies (`/create`, `/order`) → SwapOrder: provider status →
 * OpenReceive state (including the EMERGENCY refund/attention branches),
 * field-by-field fallback to the order already persisted, the USD fee pair, and
 * the deposit-address shape check that gates every address handed to a payer.
 */

import { recordOrEmpty, unixSeconds } from "@openreceive/core";
import { isValidSwapAddressForNetwork, type SwapPayInAsset } from "./assets.ts";
import {
  optionalNestedString,
  optionalStringArrayField,
  optionalStringField,
  readDecimalAmountString,
  readUnixSeconds,
  requiredString,
} from "./fixedfloat-fields.ts";
import type {
  SwapAttentionReason,
  SwapFee,
  SwapOrder,
  SwapProviderState,
  SwapRefundReason,
} from "./provider.ts";

export interface FixedFloatOrderInput {
  readonly provider: string;
  readonly payInAsset: SwapPayInAsset;
  /** The order we already persisted, when this is a poll rather than a create. */
  readonly fallback?: SwapOrder;
  readonly now?: () => number;
}

/**
 * Shape the resolved fields into the SwapOrder we both persist as swap_data and
 * hand back to the payer (via publicSwap). Nothing here reads the raw body.
 */
export function normalizeFixedFloatOrder(data: unknown, input: FixedFloatOrderInput): SwapOrder {
  const fields = extractFixedFloatOrderFields(recordOrEmpty(data), input);
  const { attention, attention_reason } = fields.status;
  return {
    provider: input.provider,
    provider_order_id: fields.providerOrderId,
    provider_token: fields.providerToken,
    pay_in_asset: input.payInAsset,
    deposit_address: fields.depositAddress,
    ...(fields.depositMemo === undefined ? {} : { deposit_memo: fields.depositMemo }),
    deposit_amount: fields.depositAmount,
    expires_at: fields.expiresAt,
    state: fields.status.state,
    ...(fields.depositTxId === undefined ? {} : { deposit_tx_id: fields.depositTxId }),
    ...(fields.payoutTxId === undefined ? {} : { payout_tx_id: fields.payoutTxId }),
    ...(fields.refundTxId === undefined ? {} : { refund_tx_id: fields.refundTxId }),
    ...(attention === undefined ? {} : { attention }),
    ...(attention_reason === undefined ? {} : { attention_reason }),
    ...(fields.refundReason === undefined ? {} : { refund_reason: fields.refundReason }),
    ...(fields.depositReceivedAmount === undefined
      ? {}
      : { deposit_received_amount: fields.depositReceivedAmount }),
    ...(fields.refundAmount === undefined ? {} : { refund_amount: fields.refundAmount }),
    ...(fields.emergencyRepeat === undefined ? {} : { emergency_repeat: fields.emergencyRepeat }),
    ...(fields.fee === undefined ? {} : { fee: fields.fee }),
    raw: data,
  };
}

// FixedFloat reports the USD equivalents of both sides of the exchange (from.usd is the
// value of the crypto the payer sends, to.usd the value delivered to the merchant). Their
// gap is the swap fee the payer absorbs, so we surface both to explain the price.
export function readFixedFloatOrderFee(record: Record<string, unknown>): SwapFee | undefined {
  const payInFiat = optionalNestedString(record, ["from", "usd"]);
  const payoutFiat = optionalNestedString(record, ["to", "usd"]);
  if (payInFiat === undefined || payoutFiat === undefined) return undefined;
  return { currency: "USD", pay_in_fiat: payInFiat, payout_fiat: payoutFiat };
}

/**
 * A field the provider must eventually supply: the fresh response wins, the value
 * we persisted is the fallback, and only a field neither source can supply fails.
 */
function requiredOrderField(
  record: Record<string, unknown>,
  field: string,
  fallback: string | undefined,
  label: string,
): string {
  return optionalStringField(record, field) ?? fallback ?? requiredString(record[field], label);
}

/**
 * Read a FixedFloat order body, resolving every field against what we already
 * persisted. Extraction and fallback are deliberately one step, not two: a thin
 * poll response must never erase an order we already know about.
 */
function extractFixedFloatOrderFields(
  record: Record<string, unknown>,
  input: FixedFloatOrderInput,
) {
  const fallback = input.fallback;
  const from = recordOrEmpty(record.from);
  const emergency = recordOrEmpty(record.emergency);
  const refundTxId =
    optionalNestedString(record, ["back", "tx", "id"]) ??
    optionalNestedString(record, ["refund", "tx", "id"]) ??
    fallback?.refund_tx_id;
  const status = normalizeFixedFloatStatus(
    optionalStringField(record, "status") ?? fallback?.state ?? "NEW",
    emergency,
    refundTxId,
  );
  // Checked on the same path that produces it, so no deposit address ever reaches
  // a payer without its network shape being validated first.
  const depositAddress = requiredOrderField(
    from,
    "address",
    fallback?.deposit_address,
    "from.address",
  );
  assertFixedFloatDepositAddressShape(input.payInAsset, depositAddress);
  return {
    status,
    depositAddress,
    refundTxId,
    providerOrderId: requiredOrderField(record, "id", fallback?.provider_order_id, "id"),
    providerToken: requiredOrderField(record, "token", fallback?.provider_token, "token"),
    depositAmount: requiredOrderField(from, "amount", fallback?.deposit_amount, "from.amount"),
    expiresAt:
      readUnixSeconds(recordOrEmpty(record.time).expiration) ??
      fallback?.expires_at ??
      (input.now ?? unixSeconds)() + 600,
    depositMemo: optionalStringField(from, "tag") ?? fallback?.deposit_memo,
    depositTxId: optionalNestedString(record, ["from", "tx", "id"]) ?? fallback?.deposit_tx_id,
    payoutTxId: optionalNestedString(record, ["to", "tx", "id"]) ?? fallback?.payout_tx_id,
    depositReceivedAmount:
      readDecimalAmountString(optionalNestedString(record, ["from", "tx", "amount"])) ??
      fallback?.deposit_received_amount,
    refundAmount:
      readDecimalAmountString(optionalNestedString(record, ["back", "amount"])) ??
      fallback?.refund_amount,
    refundReason:
      status.refund_reason ??
      (isRefundPathState(status.state) ? fallback?.refund_reason : undefined),
    emergencyRepeat: readEmergencyRepeat(emergency) ?? fallback?.emergency_repeat,
    fee: readFixedFloatOrderFee(record) ?? fallback?.fee,
  };
}

function assertFixedFloatDepositAddressShape(
  payInAsset: SwapPayInAsset,
  depositAddress: string,
): void {
  if (!isValidSwapAddressForNetwork(payInAsset, depositAddress)) {
    throw new Error("FixedFloat deposit address is not valid for this asset.");
  }
}

function normalizeFixedFloatStatus(
  status: string,
  emergency: Record<string, unknown> | undefined,
  refundTxId: string | undefined,
): {
  readonly state: SwapProviderState;
  readonly attention?: boolean;
  readonly attention_reason?: SwapAttentionReason;
  readonly refund_reason?: SwapRefundReason;
} {
  const normalized = status.toUpperCase();
  if (refundTxId !== undefined && (normalized === "DONE" || normalized === "FINISHED")) {
    return { state: "refunded" };
  }
  if (normalized === "NEW") return { state: "awaiting_deposit" };
  if (normalized === "PENDING") return { state: "confirming" };
  if (normalized === "EXCHANGE") return { state: "exchanging" };
  if (normalized === "WITHDRAW") return { state: "paying_invoice" };
  if (normalized === "DONE") return { state: "completed" };
  if (normalized === "EXPIRED") return { state: "expired" };
  if (normalized === "EMERGENCY") {
    const choice = optionalStringField(emergency, "choice")?.toUpperCase();
    const emergencyStatuses = optionalStringArrayField(emergency, "status").map((item) =>
      item.toUpperCase(),
    );
    const refundReason = refundReasonFromEmergencyStatuses(emergencyStatuses);
    if (choice === "REFUND" && refundTxId !== undefined) {
      return {
        state: "refunded",
        ...(refundReason === undefined ? {} : { refund_reason: refundReason }),
      };
    }
    if (choice === "REFUND") {
      return {
        state: "refund_pending",
        ...(refundReason === undefined ? {} : { refund_reason: refundReason }),
      };
    }
    if (choice === "EXCHANGE") {
      return {
        state: "attention",
        attention: true,
        attention_reason: "provider_reported_emergency",
      };
    }
    if (
      emergencyStatuses.includes("MORE") ||
      emergencyStatuses.includes("OVER") ||
      emergencyStatuses.includes("OVERPAID")
    ) {
      return {
        state: "attention",
        attention: true,
        attention_reason: "provider_reported_emergency",
      };
    }
    return {
      state: "refund_required",
      ...(refundReason === undefined ? {} : { refund_reason: refundReason }),
    };
  }
  if (normalized.includes("FAIL")) return { state: "failed" };
  // An unrecognized status is NOT a provider-reported emergency: label it as
  // unknown so operators land on the right runbook section.
  return { state: "attention", attention: true, attention_reason: "provider_status_unrecognized" };
}

function refundReasonFromEmergencyStatuses(
  statuses: readonly string[],
): SwapRefundReason | undefined {
  const less = statuses.includes("LESS");
  const expired = statuses.includes("EXPIRED");
  if (less && expired) return "underpaid_and_late";
  if (less) return "underpaid";
  if (expired) return "late_deposit";
  return undefined;
}

function isRefundPathState(state: SwapProviderState): boolean {
  return state === "refund_required" || state === "refund_pending" || state === "refunded";
}

function readEmergencyRepeat(emergency: Record<string, unknown> | undefined): boolean | undefined {
  if (emergency === undefined) return undefined;
  const value = emergency.repeat;
  if (typeof value === "boolean") return value;
  if (value === 0 || value === "0") return false;
  if (value === 1 || value === "1") return true;
  return undefined;
}
