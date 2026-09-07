/**
 * FixedFloat order bodies (`/create`, `/order`) → SwapOrder: provider status →
 * OpenReceive state (including the EMERGENCY refund/attention branches),
 * field-by-field fallback to the order already persisted, and the USD fee pair.
 */

import { recordOrEmpty } from "@openreceive/core";
import {
  type GeneratedSwapStatusRow,
  OPENRECEIVE_SWAP_EMERGENCY_STATUS_ALIASES,
  OPENRECEIVE_SWAP_REFUND_REASON_ROWS,
  OPENRECEIVE_SWAP_STATUS_ROWS,
} from "../generated/swap-state-table.ts";
import type { SwapPayInAsset } from "./assets.ts";
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

function requiredExpiresAt(expiresAt: number | undefined): number {
  if (expiresAt === undefined) {
    throw new Error("FixedFloat order is missing time.expiration.");
  }
  return expiresAt;
}

/** The persisted order's own state fields, carried through a thin poll body. */
function persistedStatus(fallback: SwapOrder): {
  readonly state: SwapProviderState;
  readonly attention?: boolean;
  readonly attention_reason?: SwapAttentionReason;
  readonly refund_reason?: SwapRefundReason;
} {
  return {
    state: fallback.state,
    ...(fallback.attention === undefined ? {} : { attention: fallback.attention }),
    ...(fallback.attention_reason === undefined
      ? {}
      : { attention_reason: fallback.attention_reason }),
    ...(fallback.refund_reason === undefined ? {} : { refund_reason: fallback.refund_reason }),
  };
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
  const rawStatus = optionalStringField(record, "status");
  // A thin poll body with no `status` keeps the state we already persisted
  // VERBATIM. Re-normalizing it would be a category error: `fallback.state` is
  // an OpenReceive SwapProviderState, and normalizeFixedFloatStatus only speaks
  // FixedFloat statuses — it would map "awaiting_deposit" to attention.
  const status =
    rawStatus === undefined && fallback !== undefined
      ? persistedStatus(fallback)
      : normalizeFixedFloatStatus(rawStatus ?? "NEW", emergency, refundTxId);
  return {
    status,
    depositAddress: requiredOrderField(from, "address", fallback?.deposit_address, "from.address"),
    refundTxId,
    providerOrderId: requiredOrderField(record, "id", fallback?.provider_order_id, "id"),
    providerToken: requiredOrderField(record, "token", fallback?.provider_token, "token"),
    depositAmount: requiredOrderField(from, "amount", fallback?.deposit_amount, "from.amount"),
    // No invented deadline: the provider states the expiry, and on a thin poll
    // body the one we already persisted stands. A create body without either is
    // a provider contract break, not something to paper over with now + 10min.
    expiresAt: requiredExpiresAt(
      readUnixSeconds(recordOrEmpty(record.time).expiration) ?? fallback?.expires_at,
    ),
    depositMemo: optionalStringField(from, "tag") ?? fallback?.deposit_memo,
    depositTxId: optionalNestedString(record, ["from", "tx", "id"]) ?? fallback?.deposit_tx_id,
    payoutTxId: optionalNestedString(record, ["to", "tx", "id"]) ?? fallback?.payout_tx_id,
    depositReceivedAmount:
      readDecimalAmountString(
        optionalNestedString(record, ["from", "tx", "amount"]),
        "from.tx.amount",
      ) ?? fallback?.deposit_received_amount,
    refundAmount:
      readDecimalAmountString(optionalNestedString(record, ["back", "amount"]), "back.amount") ??
      fallback?.refund_amount,
    refundReason:
      status.refund_reason ??
      (isRefundPathState(status.state) ? fallback?.refund_reason : undefined),
    emergencyRepeat: readEmergencyRepeat(emergency) ?? fallback?.emergency_repeat,
    fee: readFixedFloatOrderFee(record) ?? fallback?.fee,
  };
}

/**
 * FixedFloat status + emergency block + refund-tx presence → OpenReceive state and
 * reasons: an interpreter of spec/data/swap-state-table.json (rendered into
 * ../generated/swap-state-table.ts), first-match-wins. Pinned across engines by
 * spec/test-vectors/swap-state.json; how to read the rows lives in the JSON.
 */
export function normalizeFixedFloatStatus(
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
  const refundTxPresent = refundTxId !== undefined;
  const choice = optionalStringField(emergency, "choice")?.toUpperCase();
  // The validator asserts the table ends in a catch-all row, so a match always exists.
  const row = OPENRECEIVE_SWAP_STATUS_ROWS.find(
    (candidate) =>
      (candidate.status === "*"
        ? candidate.status_contains === undefined || normalized.includes(candidate.status_contains)
        : candidate.status === normalized) &&
      (candidate.refund_tx_present === "any" || candidate.refund_tx_present === refundTxPresent) &&
      (candidate.choice === "any" ||
        (choice === undefined ? candidate.choice === "absent" : candidate.choice === choice)),
  ) as GeneratedSwapStatusRow;
  const refundReason = row.refund_reason_from_emergency
    ? refundReasonFromEmergencyStatuses(optionalStringArrayField(emergency, "status"))
    : undefined;
  return {
    state: row.state,
    ...(row.attention_reason === undefined
      ? {}
      : { attention: true, attention_reason: row.attention_reason }),
    ...(refundReason === undefined ? {} : { refund_reason: refundReason }),
  };
}

function refundReasonFromEmergencyStatuses(
  statuses: readonly string[],
): SwapRefundReason | undefined {
  const present = new Set(
    statuses.map((item) => {
      const upper = item.toUpperCase();
      return OPENRECEIVE_SWAP_EMERGENCY_STATUS_ALIASES[upper] ?? upper;
    }),
  );
  return OPENRECEIVE_SWAP_REFUND_REASON_ROWS.find((row) =>
    row.all_of.every((item) => present.has(item)),
  )?.refund_reason;
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
