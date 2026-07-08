import { randomBytes } from "node:crypto";
import type {
  InvoiceStorageRow,
  OpenReceiveBitcoinAmount,
  OpenReceiveRateQuote,
  StoredRecord,
} from "@openreceive/core";
import {
  isOpenReceiveSwapPayInAsset,
  type OpenReceiveSwapAttentionReason,
  type OpenReceiveSwapOrder,
  type OpenReceiveSwapPayInAsset,
  type OpenReceiveSwapProviderState,
} from "../swap/index.ts";
import {
  isRecord,
  optionalSafeInteger,
  optionalString,
  requiredValue,
  serviceError,
} from "./core-utils.ts";
import type {
  OpenReceiveCheckout,
  OpenReceiveCheckoutModel,
  OpenReceiveCreateCheckoutAmount,
  OpenReceiveInvoice,
  OpenReceiveInvoiceModel,
  OpenReceiveOrder,
  OpenReceiveOrderModel,
  OpenReceivePublicSwap,
  OpenReceiveSwapAttempt,
  OrderScanMeta,
} from "./types.ts";

export const OPENRECEIVE_SWAP_REFUND_NONCE_SECONDS = 10 * 60;

export function readStoredAmountSpec(
  row: InvoiceStorageRow,
): OpenReceiveCreateCheckoutAmount | undefined {
  const value = row.metadata.amount_spec;
  if (!isRecord(value)) return undefined;
  if (isRecord(value.btc)) {
    return {
      btc: value.btc as unknown as OpenReceiveBitcoinAmount,
    };
  }
  if (isRecord(value.fiat)) {
    const currency = optionalString(value.fiat.currency);
    const fiatValue = optionalString(value.fiat.value);
    if (currency !== undefined && fiatValue !== undefined) {
      return {
        fiat: {
          currency,
          value: fiatValue,
        },
      };
    }
  }
  return undefined;
}

export function buildOrder(
  records: readonly StoredRecord[],
  scanMeta: OrderScanMeta,
  now: number,
): OpenReceiveOrderModel {
  if (records.length === 0) {
    throw serviceError(500, "INTERNAL", "Order has no invoices.");
  }
  const checkouts = groupCheckouts(records, now);
  const paidCheckout = checkouts.find((checkout) => checkout.status === "paid");
  const activeCheckout = currentOpenCheckout(checkouts);
  const paid = paidCheckout !== undefined;
  const status: OpenReceiveOrderModel["status"] = paid
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
): OpenReceiveCheckoutModel[] {
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
): OpenReceiveCheckoutModel {
  const sortedRecords = [...records].sort((left, right) =>
    left.row.created_at === right.row.created_at
      ? right.row.invoice_id.localeCompare(left.row.invoice_id)
      : right.row.created_at - left.row.created_at,
  );
  const invoices = sortedRecords.map((record) => serializeInvoice(record.row, now));
  const paidInvoice = invoices.find((invoice) => invoice.status === "settled");
  const superseded = sortedRecords.some((record) => record.row.metadata.superseded === true);
  const status: OpenReceiveCheckoutModel["status"] =
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
    ...(amountSpec !== undefined && "fiat" in amountSpec
      ? {
          fiat: {
            currency: amountSpec.fiat.currency,
            value: amountSpec.fiat.value,
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
  checkouts: readonly OpenReceiveCheckoutModel[],
): OpenReceiveCheckoutModel | undefined {
  return checkouts.find((checkout) => checkout.status === "open");
}

export function retryBaseCheckout(
  checkouts: readonly OpenReceiveCheckoutModel[],
): OpenReceiveCheckoutModel | undefined {
  return checkouts.find((checkout) => checkout.status === "expired");
}

export function requireCheckout(
  checkouts: readonly OpenReceiveCheckoutModel[],
  checkoutId: string,
): OpenReceiveCheckoutModel {
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
  order: OpenReceiveSwapOrder,
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
    last_polled_at: now,
  };
}

export function swapPrivateMetadataFromProviderOrder(
  order: OpenReceiveSwapOrder,
): Record<string, unknown> {
  return {
    provider_token: order.provider_token,
  };
}

export function withSwapRefundFreshness(
  swap: Record<string, unknown>,
  state: OpenReceiveSwapProviderState,
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

export function readPublicSwap(row: InvoiceStorageRow): OpenReceivePublicSwap | undefined {
  const swap = parseSwapMetadata(row);
  if (swap === undefined) return undefined;
  const payInAsset = parseStoredSwapPayInAsset(swap.pay_in_asset);
  const provider = optionalString(swap.provider);
  const depositAddress = optionalString(swap.deposit_address);
  const depositAmount = optionalString(swap.deposit_amount);
  const providerState = optionalString(swap.provider_state) as
    | OpenReceiveSwapProviderState
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
    attempt_id: row.invoice_id,
    provider,
    ...(optionalString(swap.provider_order_id) === undefined
      ? {}
      : { provider_order_id: optionalString(swap.provider_order_id) }),
    pay_in_asset: payInAsset,
    deposit_address: depositAddress,
    ...(optionalString(swap.deposit_memo) === undefined
      ? {}
      : { deposit_memo: optionalString(swap.deposit_memo) }),
    deposit_amount: depositAmount,
    provider_state: providerState,
    provider_expires_at: providerExpiresAt,
    ...(optionalString(swap.deposit_tx_id) === undefined
      ? {}
      : { deposit_tx_id: optionalString(swap.deposit_tx_id) }),
    ...(optionalString(swap.payout_tx_id) === undefined
      ? {}
      : { payout_tx_id: optionalString(swap.payout_tx_id) }),
    ...(optionalString(swap.refund_address) === undefined
      ? {}
      : { refund_address: optionalString(swap.refund_address) }),
    ...(optionalString(swap.refund_nonce) === undefined
      ? {}
      : { refund_nonce: optionalString(swap.refund_nonce) }),
    ...(optionalString(swap.refund_nonce) === undefined ||
    optionalSafeInteger(swap.refund_nonce_expires_at) === undefined
      ? {}
      : { refund_nonce_expires_at: optionalSafeInteger(swap.refund_nonce_expires_at) }),
    ...(optionalString(swap.refund_tx_id) === undefined
      ? {}
      : { refund_tx_id: optionalString(swap.refund_tx_id) }),
    ...(typeof swap.attention === "boolean" ? { attention: swap.attention } : {}),
    ...(readSwapAttentionReason(swap.attention_reason) === undefined
      ? {}
      : { attention_reason: readSwapAttentionReason(swap.attention_reason) }),
  };
}

const SWAP_ATTENTION_REASONS: ReadonlySet<string> = new Set<OpenReceiveSwapAttentionReason>([
  "provider_completed_without_wallet_settlement",
  "provider_order_creation_stale",
  "provider_order_creation_failed",
  "provider_reported_emergency",
]);

function readSwapAttentionReason(value: unknown): OpenReceiveSwapAttentionReason | undefined {
  const reason = optionalString(value);
  return reason !== undefined && SWAP_ATTENTION_REASONS.has(reason)
    ? (reason as OpenReceiveSwapAttentionReason)
    : undefined;
}

export function readStoredSwapOrder(row: InvoiceStorageRow): OpenReceiveSwapOrder {
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
    | OpenReceiveSwapProviderState
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
): OpenReceiveSwapPayInAsset | undefined {
  return parseStoredSwapPayInAsset(parseSwapMetadata(row)?.pay_in_asset);
}

export function readStoredSwapState(
  row: InvoiceStorageRow,
): OpenReceiveSwapProviderState | undefined {
  return optionalString(parseSwapMetadata(row)?.provider_state) as
    | OpenReceiveSwapProviderState
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

export function parseStoredSwapPayInAsset(value: unknown): OpenReceiveSwapPayInAsset | undefined {
  return isOpenReceiveSwapPayInAsset(value) ? value : undefined;
}

export function toWireInvoice(model: OpenReceiveInvoiceModel): OpenReceiveInvoice {
  return {
    invoice_id: model.invoiceId,
    type: model.type,
    rail: model.rail,
    status: model.status,
    transaction_state: model.transactionState,
    workflow_state: model.workflowState,
    invoice: model.rail === "swap" ? null : model.bolt11,
    payment_hash: model.paymentHash,
    amount_msats: model.amountMsats,
    order_id: model.orderId,
    created_at: model.createdAt,
    expires_at: model.expiresAt,
    ...(model.settledAt === undefined ? {} : { settled_at: model.settledAt }),
    ...(model.settlementActionCompletedAt === undefined
      ? {}
      : { settlement_action_completed_at: model.settlementActionCompletedAt }),
    ...(model.refreshedFromInvoiceId === undefined
      ? {}
      : { refreshed_from_invoice_id: model.refreshedFromInvoiceId }),
    fiat_quote: model.fiatQuote,
    settlement_action_state: model.settlementActionState,
    ...(model.swap === undefined ? {} : { swap: model.swap }),
  };
}

export function toWireSwapAttempt(model: OpenReceiveInvoiceModel): OpenReceiveSwapAttempt {
  if (model.swap === undefined) {
    throw serviceError(500, "INTERNAL", "Swap attempt is missing swap details.");
  }
  return {
    ...model.swap,
    order_id: model.orderId,
    shadow_invoice: toWireInvoice(model),
  };
}

export function toWireCheckout(model: OpenReceiveCheckoutModel): OpenReceiveCheckout {
  return {
    checkout_id: model.checkoutId,
    order_id: model.orderId,
    status: model.status,
    amount_msats: model.amountMsats,
    ...(model.fiat === undefined ? {} : { fiat: model.fiat }),
    ...(model.active === undefined ? {} : { active: toWireInvoice(model.active) }),
    invoices: model.invoices.map(toWireInvoice),
    ...(model.paidAt === undefined ? {} : { paid_at: model.paidAt }),
    created_at: model.createdAt,
  };
}

export function toWireOrder(model: OpenReceiveOrderModel): OpenReceiveOrder {
  return {
    order_id: model.orderId,
    status: model.status,
    paid: model.paid,
    ...(model.paidAt === undefined ? {} : { paid_at: model.paidAt }),
    ...(model.displayCheckout === undefined
      ? {}
      : { display_checkout: toWireCheckout(model.displayCheckout) }),
    ...(model.paidCheckout === undefined
      ? {}
      : { paid_checkout: toWireCheckout(model.paidCheckout) }),
    ...(model.activeCheckout === undefined
      ? {}
      : { active_checkout: toWireCheckout(model.activeCheckout) }),
    checkouts: model.checkouts.map(toWireCheckout),
    wallet_scan_performed: model.walletScanPerformed,
    transactions_checked: model.transactionsChecked,
  };
}

export function serializeInvoice(row: InvoiceStorageRow, now: number): OpenReceiveInvoiceModel {
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
): OpenReceiveInvoiceModel["status"] {
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
