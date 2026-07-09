import { randomBytes } from "node:crypto";
import {
  isOpenReceiveBitcoinAmountCurrency,
  type InvoiceStorageRow,
  type OpenReceiveRateQuote,
  type StoredRecord,
} from "@openreceive/core";
import {
  isOpenReceiveSwapPayInAsset,
  type SwapAttentionReason,
  type SwapFee,
  type SwapOrder,
  type SwapPayInAsset,
  type SwapProviderState,
} from "../swap/index.ts";
import {
  isRecord,
  optionalSafeInteger,
  optionalString,
  requiredValue,
  serviceError,
} from "./core-utils.ts";
import type {
  Checkout,
  CreateCheckoutAmount,
  Invoice,
  Order,
  PublicSwap,
  SwapAttempt,
  OrderScanMeta,
} from "./types.ts";

export const OPENRECEIVE_SWAP_REFUND_NONCE_SECONDS = 10 * 60;

export function readStoredAmountSpec(
  row: InvoiceStorageRow,
): CreateCheckoutAmount | undefined {
  const value = row.metadata.amount_spec;
  if (!isRecord(value)) return undefined;

  // New shape: { sats } | { currency, value }
  if ("sats" in value && value.sats !== undefined) {
    const sats = optionalString(value.sats) ?? (typeof value.sats === "number" ? String(value.sats) : undefined);
    if (sats !== undefined) return { sats };
  }
  {
    const currency = optionalString(value.currency);
    const amountValue = optionalString(value.value);
    if (currency !== undefined && amountValue !== undefined) {
      return { currency, value: amountValue };
    }
  }

  // Legacy stored shape: { btc: {...} } | { fiat: {...} }
  if (isRecord(value.btc)) {
    const currency = optionalString(value.btc.currency);
    const btcValue = optionalString(value.btc.value);
    if (currency === "SATS" || currency === "SAT") {
      return { sats: btcValue ?? "0" };
    }
    if (currency !== undefined && btcValue !== undefined) {
      return { currency, value: btcValue };
    }
  }
  if (isRecord(value.fiat)) {
    const currency = optionalString(value.fiat.currency);
    const fiatValue = optionalString(value.fiat.value);
    if (currency !== undefined && fiatValue !== undefined) {
      return { currency, value: fiatValue };
    }
  }
  return undefined;
}

export function buildOrder(
  records: readonly StoredRecord[],
  scanMeta: OrderScanMeta,
  now: number,
): Order {
  if (records.length === 0) {
    throw serviceError(500, "INTERNAL", "Order has no invoices.");
  }
  const checkouts = groupCheckouts(records, now);
  const paidCheckout = checkouts.find((checkout) => checkout.status === "paid");
  const activeCheckout = currentOpenCheckout(checkouts);
  const paid = paidCheckout !== undefined;
  const status: Order["status"] = paid
    ? "paid"
    : activeCheckout !== undefined
      ? "pending"
      : "expired";
  const displayCheckout = paidCheckout ?? activeCheckout ?? checkouts[0];

  return {
    orderId: readStoredOrderId(records[0].row),
    status,
    paid,
    ...(paidCheckout?.paidAt === undefined ? {} : { paidAt: paidCheckout.paidAt }),
    ...(displayCheckout === undefined ? {} : { displayCheckout }),
    ...(paidCheckout === undefined ? {} : { paidCheckout }),
    ...(activeCheckout === undefined ? {} : { activeCheckout }),
    checkouts,
    walletScanPerformed: scanMeta.walletScanPerformed,
    transactionsChecked: scanMeta.transactionsChecked,
  };
}

export function groupCheckouts(
  records: readonly StoredRecord[],
  now: number,
): Checkout[] {
  const groups = new Map<string, StoredRecord[]>();
  for (const record of records) {
    const checkoutId = readStoredCheckoutId(record.row);
    const group = groups.get(checkoutId) ?? [];
    group.push(record);
    groups.set(checkoutId, group);
  }

  return [...groups.entries()]
    .map(([checkoutId, group]) => buildCheckout(checkoutId, group, now))
    .sort((left, right) =>
      left.createdAt === right.createdAt
        ? right.checkoutId.localeCompare(left.checkoutId)
        : right.createdAt - left.createdAt,
    );
}

export function buildCheckout(
  checkoutId: string,
  records: readonly StoredRecord[],
  now: number,
): Checkout {
  const sortedRecords = [...records].sort((left, right) =>
    left.row.created_at === right.row.created_at
      ? right.row.invoice_id.localeCompare(left.row.invoice_id)
      : right.row.created_at - left.row.created_at,
  );
  const invoices = sortedRecords.map((record) => serializeInvoice(record.row, now));
  const paidInvoice = invoices.find((invoice) => invoice.status === "settled");
  const superseded = sortedRecords.some((record) => record.row.metadata.superseded === true);
  const status: Checkout["status"] =
    paidInvoice !== undefined
      ? "paid"
      : superseded
        ? "superseded"
        : invoices.every((invoice) => invoice.status === "expired" || invoice.status === "failed")
          ? "expired"
          : "open";
  const active =
    status === "open"
      ? invoices.find(
          (invoice) =>
            invoice.rail !== "swap" && invoice.status === "pending" && invoice.expiresAt > now,
        )
      : undefined;
  const amountSpec = readStoredAmountSpec(sortedRecords[0].row);
  const base = active ?? paidInvoice ?? requiredValue(invoices[0]);

  return {
    checkoutId,
    orderId: readStoredOrderId(sortedRecords[0].row),
    status,
    amountMsats: base.amountMsats,
    ...(amountSpec !== undefined &&
    "currency" in amountSpec &&
    amountSpec.currency !== undefined &&
    !isOpenReceiveBitcoinAmountCurrency(amountSpec.currency)
      ? {
          fiat: {
            currency: amountSpec.currency,
            value: amountSpec.value,
          },
        }
      : {}),
    ...(active === undefined ? {} : { active }),
    invoices,
    ...(paidInvoice?.settledAt === undefined ? {} : { paidAt: paidInvoice.settledAt }),
    createdAt: Math.min(...sortedRecords.map((record) => record.row.created_at)),
  };
}

export function currentOpenCheckout(
  checkouts: readonly Checkout[],
): Checkout | undefined {
  return checkouts.find((checkout) => checkout.status === "open");
}

export function retryBaseCheckout(
  checkouts: readonly Checkout[],
): Checkout | undefined {
  return checkouts.find((checkout) => checkout.status === "expired");
}

export function requireCheckout(
  checkouts: readonly Checkout[],
  checkoutId: string,
): Checkout {
  const checkout = checkouts.find((candidate) => candidate.checkoutId === checkoutId);
  if (checkout === undefined) {
    throw serviceError(500, "INTERNAL", "Created checkout was not readable.");
  }
  return checkout;
}

export function swapBaseMetadata(row: InvoiceStorageRow): Record<string, unknown> {
  const metadata = structuredClone(row.metadata);
  delete metadata.superseded;
  delete metadata.rail;
  delete metadata.swap;
  delete metadata.swap_private;
  delete metadata.swap_attempt_key;
  return metadata;
}

export function swapMetadataFromProviderOrder(
  order: SwapOrder,
  now: number,
): Record<string, unknown> {
  return {
    provider: order.provider,
    provider_order_id: order.provider_order_id,
    pay_in_asset: order.pay_in_asset,
    deposit_address: order.deposit_address,
    ...(order.deposit_memo === undefined ? {} : { deposit_memo: order.deposit_memo }),
    deposit_amount: order.deposit_amount,
    provider_state: order.state,
    provider_expires_at: order.expires_at,
    ...(order.deposit_tx_id === undefined ? {} : { deposit_tx_id: order.deposit_tx_id }),
    ...(order.payout_tx_id === undefined ? {} : { payout_tx_id: order.payout_tx_id }),
    ...(order.refund_tx_id === undefined ? {} : { refund_tx_id: order.refund_tx_id }),
    ...(order.attention === undefined ? {} : { attention: order.attention }),
    ...(order.attention_reason === undefined ? {} : { attention_reason: order.attention_reason }),
    ...(order.emergency_repeat === undefined
      ? {}
      : { emergency_repeat: order.emergency_repeat }),
    ...(order.fee === undefined ? {} : { fee: order.fee }),
    last_polled_at: now,
  };
}

/**
 * Partial order for provider-poll state merges. Once a refund is confirmed locally
 * (`refund_pending`), a stale provider poll that still shows `choice: NONE` must not
 * demote us back to `refund_required` (which would reissue a nonce and allow a second
 * `/emergency`). Advances to `refunded` or `attention` are still allowed.
 */
export function resolvePolledSwapProviderState(
  previousState: string | undefined,
  polledState: SwapProviderState,
): SwapProviderState {
  if (previousState === "refund_pending") {
    if (polledState === "refund_pending" || polledState === "refunded" || polledState === "attention") {
      return polledState;
    }
    return "refund_pending";
  }
  if (previousState === "refunded") {
    return "refunded";
  }
  return polledState;
}

export function swapPrivateMetadataFromProviderOrder(
  order: SwapOrder,
): Record<string, unknown> {
  return {
    provider_token: order.provider_token,
  };
}

export function withSwapRefundFreshness(
  swap: Record<string, unknown>,
  state: SwapProviderState,
  now: number,
): Record<string, unknown> {
  const {
    refund_nonce: _refundNonce,
    refund_nonce_expires_at: _refundNonceExpiresAt,
    ...withoutNonce
  } = swap;
  if (state !== "refund_required") return withoutNonce;

  const existingNonce = optionalString(swap.refund_nonce);
  const existingExpiresAt = optionalSafeInteger(swap.refund_nonce_expires_at);
  if (existingNonce !== undefined && existingExpiresAt !== undefined && existingExpiresAt > now) {
    return swap;
  }

  return {
    ...withoutNonce,
    refund_nonce: createSwapRefundNonce(),
    refund_nonce_expires_at: now + OPENRECEIVE_SWAP_REFUND_NONCE_SECONDS,
  };
}

export function createSwapRefundNonce(): string {
  return `or_ref_${randomBytes(16).toString("hex")}`;
}

export function readInvoiceRail(row: InvoiceStorageRow): "lightning" | "swap" {
  return row.metadata.rail === "swap" ? "swap" : "lightning";
}

export function readPublicSwap(row: InvoiceStorageRow): PublicSwap | undefined {
  const swap = parseSwapMetadata(row);
  if (swap === undefined) return undefined;
  const payInAsset = parseStoredSwapPayInAsset(swap.pay_in_asset);
  const provider = optionalString(swap.provider);
  const depositAddress = optionalString(swap.deposit_address);
  const depositAmount = optionalString(swap.deposit_amount);
  const providerState = optionalString(swap.provider_state) as
    | SwapProviderState
    | undefined;
  const providerExpiresAt = optionalSafeInteger(swap.provider_expires_at);
  if (
    payInAsset === undefined ||
    provider === undefined ||
    depositAddress === undefined ||
    depositAmount === undefined ||
    providerState === undefined ||
    providerExpiresAt === undefined
  ) {
    return undefined;
  }

  return {
    attemptId: row.invoice_id,
    provider,
    ...(optionalString(swap.provider_order_id) === undefined
      ? {}
      : { providerOrderId: optionalString(swap.provider_order_id) }),
    payInAsset,
    depositAddress,
    ...(optionalString(swap.deposit_memo) === undefined
      ? {}
      : { depositMemo: optionalString(swap.deposit_memo) }),
    depositAmount,
    providerState,
    providerExpiresAt,
    ...(optionalString(swap.deposit_tx_id) === undefined
      ? {}
      : { depositTxId: optionalString(swap.deposit_tx_id) }),
    ...(optionalString(swap.payout_tx_id) === undefined
      ? {}
      : { payoutTxId: optionalString(swap.payout_tx_id) }),
    ...(optionalString(swap.refund_address) === undefined
      ? {}
      : { refundAddress: optionalString(swap.refund_address) }),
    ...(optionalString(swap.refund_nonce) === undefined
      ? {}
      : { refundNonce: optionalString(swap.refund_nonce) }),
    ...(optionalString(swap.refund_nonce) === undefined ||
    optionalSafeInteger(swap.refund_nonce_expires_at) === undefined
      ? {}
      : { refundNonceExpiresAt: optionalSafeInteger(swap.refund_nonce_expires_at) }),
    ...(optionalString(swap.refund_tx_id) === undefined
      ? {}
      : { refundTxId: optionalString(swap.refund_tx_id) }),
    ...(typeof swap.attention === "boolean" ? { attention: swap.attention } : {}),
    ...(readSwapAttentionReason(swap.attention_reason) === undefined
      ? {}
      : { attentionReason: readSwapAttentionReason(swap.attention_reason) }),
    ...(typeof swap.emergency_repeat === "boolean"
      ? { emergencyRepeat: swap.emergency_repeat }
      : {}),
    ...(readStoredSwapFee(swap.fee) === undefined ? {} : { fee: readStoredSwapFee(swap.fee) }),
  };
}

function readStoredSwapFee(value: unknown): SwapFee | undefined {
  if (!isRecord(value)) return undefined;
  const currency = optionalString(value.currency);
  const payInFiat = optionalString(value.pay_in_fiat);
  const payoutFiat = optionalString(value.payout_fiat);
  if (currency === undefined || payInFiat === undefined || payoutFiat === undefined) {
    return undefined;
  }
  return { currency, pay_in_fiat: payInFiat, payout_fiat: payoutFiat };
}

const SWAP_ATTENTION_REASONS: ReadonlySet<string> = new Set<SwapAttentionReason>([
  "provider_completed_without_wallet_settlement",
  "provider_order_creation_stale",
  "provider_order_creation_failed",
  "provider_order_creation_needs_reconcile",
  "provider_reported_emergency",
  "provider_order_expires_after_shadow_invoice",
]);

function readSwapAttentionReason(value: unknown): SwapAttentionReason | undefined {
  const reason = optionalString(value);
  return reason !== undefined && SWAP_ATTENTION_REASONS.has(reason)
    ? (reason as SwapAttentionReason)
    : undefined;
}

export function readStoredSwapOrder(row: InvoiceStorageRow): SwapOrder {
  const swap = parseSwapMetadata(row);
  const swapPrivate = parseSwapPrivateMetadata(row);
  if (swap === undefined) {
    throw serviceError(500, "INTERNAL", "Stored swap metadata is missing.");
  }
  const provider = optionalString(swap.provider);
  const providerOrderId = optionalString(swap.provider_order_id);
  const providerToken =
    optionalString(swapPrivate?.provider_token) ?? optionalString(swap.provider_token);
  const payInAsset = parseStoredSwapPayInAsset(swap.pay_in_asset);
  const depositAddress = optionalString(swap.deposit_address);
  const depositAmount = optionalString(swap.deposit_amount);
  const providerState = optionalString(swap.provider_state) as
    | SwapProviderState
    | undefined;
  const providerExpiresAt = optionalSafeInteger(swap.provider_expires_at);
  if (
    provider === undefined ||
    providerOrderId === undefined ||
    providerToken === undefined ||
    payInAsset === undefined ||
    depositAddress === undefined ||
    depositAmount === undefined ||
    providerState === undefined ||
    providerExpiresAt === undefined
  ) {
    throw serviceError(500, "INTERNAL", "Stored swap metadata is incomplete.");
  }

  return {
    provider,
    provider_order_id: providerOrderId,
    provider_token: providerToken,
    pay_in_asset: payInAsset,
    deposit_address: depositAddress,
    ...(optionalString(swap.deposit_memo) === undefined
      ? {}
      : { deposit_memo: optionalString(swap.deposit_memo) }),
    deposit_amount: depositAmount,
    expires_at: providerExpiresAt,
    state: providerState,
    ...(optionalString(swap.deposit_tx_id) === undefined
      ? {}
      : { deposit_tx_id: optionalString(swap.deposit_tx_id) }),
    ...(optionalString(swap.payout_tx_id) === undefined
      ? {}
      : { payout_tx_id: optionalString(swap.payout_tx_id) }),
    ...(optionalString(swap.refund_tx_id) === undefined
      ? {}
      : { refund_tx_id: optionalString(swap.refund_tx_id) }),
    ...(typeof swap.attention === "boolean" ? { attention: swap.attention } : {}),
  };
}

export function parseSwapMetadata(row: InvoiceStorageRow): Record<string, unknown> | undefined {
  if (readInvoiceRail(row) !== "swap") return undefined;
  return isRecord(row.metadata.swap) ? row.metadata.swap : undefined;
}

export function parseSwapPrivateMetadata(
  row: InvoiceStorageRow,
): Record<string, unknown> | undefined {
  if (readInvoiceRail(row) !== "swap") return undefined;
  return isRecord(row.metadata.swap_private) ? row.metadata.swap_private : undefined;
}

export function readStoredSwapPayInAsset(
  row: InvoiceStorageRow,
): SwapPayInAsset | undefined {
  return parseStoredSwapPayInAsset(parseSwapMetadata(row)?.pay_in_asset);
}

export function readStoredSwapState(
  row: InvoiceStorageRow,
): SwapProviderState | undefined {
  return optionalString(parseSwapMetadata(row)?.provider_state) as
    | SwapProviderState
    | undefined;
}

export function readStoredSwapLastPolledAt(row: InvoiceStorageRow): number | undefined {
  return optionalSafeInteger(parseSwapMetadata(row)?.last_polled_at);
}

export function storedSwapHasProviderOrder(row: InvoiceStorageRow): boolean {
  const swap = parseSwapMetadata(row);
  const swapPrivate = parseSwapPrivateMetadata(row);
  return (
    optionalString(swap?.provider_order_id) !== undefined &&
    (optionalString(swapPrivate?.provider_token) !== undefined ||
      optionalString(swap?.provider_token) !== undefined)
  );
}

export function parseStoredSwapPayInAsset(value: unknown): SwapPayInAsset | undefined {
  return isOpenReceiveSwapPayInAsset(value) ? value : undefined;
}

/**
 * Lift a swap-rail invoice into the payer-facing {@link SwapAttempt} shape
 * (top-level deposit fields + `shadowInvoice`).
 */
export function toSwapAttempt(invoice: Invoice): SwapAttempt {
  if (invoice.swap === undefined) {
    throw serviceError(500, "INTERNAL", "Swap attempt is missing swap details.");
  }
  return {
    ...invoice.swap,
    orderId: invoice.orderId,
    shadowInvoice: invoice,
  };
}

export function serializeInvoice(row: InvoiceStorageRow, now: number): Invoice {
  const swap = readPublicSwap(row);
  return {
    invoiceId: row.invoice_id,
    type: "incoming",
    rail: readInvoiceRail(row),
    status: deriveInvoiceStatus(row, now),
    transactionState: row.transaction_state,
    workflowState: row.workflow_state,
    bolt11: row.invoice,
    paymentHash: row.payment_hash,
    amountMsats: row.amount_msats,
    orderId: readStoredOrderId(row),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.settled_at === undefined ? {} : { settledAt: row.settled_at }),
    ...(row.settlement_action_completed_at === undefined
      ? {}
      : { settlementActionCompletedAt: row.settlement_action_completed_at }),
    ...(row.refreshed_from_invoice_id === undefined
      ? {}
      : { refreshedFromInvoiceId: row.refreshed_from_invoice_id }),
    fiatQuote: (row.fiat_quote ?? null) as OpenReceiveRateQuote | null,
    settlementActionState: row.settlement_action_state,
    ...(swap === undefined ? {} : { swap }),
  };
}

export function deriveInvoiceStatus(
  row: InvoiceStorageRow,
  now: number,
): Invoice["status"] {
  if (row.settled_at !== undefined || row.transaction_state === "settled") {
    return "settled";
  }
  if (row.transaction_state === "expired" || row.workflow_state === "expired_closed") {
    return "expired";
  }
  if (row.transaction_state === "failed" || row.workflow_state === "failed_closed") {
    return "failed";
  }
  if (row.expires_at <= now) {
    return "expired";
  }
  return "pending";
}

export function readStoredOrderId(row: InvoiceStorageRow): string {
  const orderId = row.metadata.order_id;
  return typeof orderId === "string" && orderId.length > 0 ? orderId : row.idempotency_key;
}

export function readStoredCheckoutId(row: InvoiceStorageRow): string {
  const checkoutId = row.metadata.checkout_id;
  if (typeof checkoutId === "string" && checkoutId.length > 0) return checkoutId;
  throw serviceError(500, "INTERNAL", "Stored invoice is missing checkout metadata.");
}
