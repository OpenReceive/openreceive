import {
  isOpenReceiveSwapPayInAsset,
  type SwapOrder,
  type SwapPayInAsset,
  type SwapProvider,
} from "../swap/index.ts";
import { createCheckout } from "./checkouts.ts";
import { serviceError } from "./core-utils.ts";
import { createAmountRequest, normalizeCreateCheckoutAmount } from "./requests.ts";
import { resolveCreateAmount } from "./pricing.ts";
import type {
  CreateSwapRequest,
  GetSwapRequest,
  OpenReceiveServiceContext,
  PublicSwap,
  SwapCheckout,
  SwapQuoteRequest,
  SwapRefundRequest,
  SwapData,
  SwapStatus,
} from "./types.ts";

export async function quoteSwap(
  context: OpenReceiveServiceContext,
  input: SwapQuoteRequest,
): Promise<unknown> {
  const amount = normalizeCreateCheckoutAmount(input.amount);
  const payInAsset = parsePayInAsset(input.payInAsset);
  const resolved = await resolveCreateAmount({
    body: createAmountRequest(amount),
    now: context.clock(),
    priceProviders: context.priceProviders,
    priceCurrencies: context.priceCurrencies,
  });
  const provider = await selectProvider(context, payInAsset);
  return await provider.quote({ payInAsset, invoiceAmountMsats: resolved.amount_msats });
}

export async function createSwap(
  context: OpenReceiveServiceContext,
  input: CreateSwapRequest,
): Promise<SwapCheckout> {
  const payInAsset = parsePayInAsset(input.payInAsset);
  const provider = await selectProvider(context, payInAsset);
  const expirySeconds = provider.invoiceExpirySeconds?.({ payInAsset });
  const checkout = await createCheckout(context, { ...input, expirySeconds });
  const order = await provider.createSwap({
    payInAsset,
    bolt11: checkout.bolt11,
    invoiceAmountMsats: checkout.amountMsats,
  });
  if (order.provider !== provider.name) {
    throw serviceError(502, "INTERNAL", "Swap provider returned the wrong provider identity.");
  }
  if (order.expires_at > checkout.expiresAt) {
    throw serviceError(502, "INTERNAL", "Swap provider order outlives its shadow Lightning invoice.");
  }
  const swapData: SwapData = {
    version: 1,
    providerOrder: recoveryOrder(order),
  };
  return {
    checkout,
    swapData,
    ...publicSwap(order, checkout.paymentHash, checkout.orderId),
  };
}

export async function getSwap(
  context: OpenReceiveServiceContext,
  input: GetSwapRequest,
): Promise<SwapStatus> {
  const recovery = readSwapData(input.swapData);
  const paymentHash = normalizePaymentHash(input.paymentHash);
  const orderId = normalizeOrderId(input.orderId);
  const provider = requireProvider(context, recovery.providerOrder.provider);
  const current = await provider.getStatus(recovery.providerOrder);
  assertProviderIdentity(recovery, current);
  return publicSwap(current, paymentHash, orderId);
}

export async function refundSwap(
  context: OpenReceiveServiceContext,
  input: SwapRefundRequest,
): Promise<SwapStatus> {
  const recovery = readSwapData(input.swapData);
  const paymentHash = normalizePaymentHash(input.paymentHash);
  const orderId = normalizeOrderId(input.orderId);
  const refundAddress = normalizeRefundAddress(input.refundAddress);
  const provider = requireProvider(context, recovery.providerOrder.provider);
  const current = await provider.getStatus(recovery.providerOrder);
  assertProviderIdentity(recovery, current);
  if (current.state !== "refund_required") {
    throw serviceError(
      409,
      "CONFLICT",
      `Swap cannot be refunded from provider state ${current.state}.`,
    );
  }
  await provider.requestRefund(current, refundAddress);
  const refreshed = await provider.getStatus(current);
  return publicSwap(refreshed, paymentHash, orderId);
}

async function selectProvider(
  context: OpenReceiveServiceContext,
  payInAsset: SwapPayInAsset,
): Promise<SwapProvider> {
  for (const provider of context.swapProviders) {
    try {
      if ((await provider.supportedPayInAssets()).has(payInAsset)) return provider;
    } catch {
      // Fail over to the next configured provider.
    }
  }
  throw serviceError(503, "INTERNAL", `No configured swap provider supports ${payInAsset}.`);
}

function requireProvider(context: OpenReceiveServiceContext, name: string): SwapProvider {
  const provider = context.swapProviders.find((candidate) => candidate.name === name);
  if (provider === undefined) {
    throw serviceError(503, "INTERNAL", `Swap provider ${name} is not configured.`);
  }
  return provider;
}

function readSwapData(value: SwapData): SwapData {
  const payload = value;
  if (
    payload?.version !== 1 ||
    typeof payload.providerOrder !== "object" ||
    payload.providerOrder === null ||
    typeof payload.providerOrder.provider !== "string" ||
    payload.providerOrder.provider.length === 0 ||
    typeof payload.providerOrder.provider_order_id !== "string" ||
    payload.providerOrder.provider_order_id.length === 0
  ) {
    throw serviceError(400, "INVALID_REQUEST", "swapData is invalid.");
  }
  return payload;
}

function recoveryOrder(order: SwapOrder): SwapOrder {
  const { raw: _raw, ...safe } = order;
  return structuredClone(safe);
}

function publicSwap(order: SwapOrder, paymentHash: string, orderId: string): PublicSwap {
  return {
    paymentHash,
    orderId,
    provider: order.provider,
    payInAsset: order.pay_in_asset,
    depositAddress: order.deposit_address,
    ...(order.deposit_memo === undefined ? {} : { depositMemo: order.deposit_memo }),
    depositAmount: order.deposit_amount,
    providerState: order.state,
    providerExpiresAt: order.expires_at,
    ...(order.deposit_tx_id === undefined ? {} : { depositTxId: order.deposit_tx_id }),
    ...(order.payout_tx_id === undefined ? {} : { payoutTxId: order.payout_tx_id }),
    ...(order.refund_tx_id === undefined ? {} : { refundTxId: order.refund_tx_id }),
    ...(order.refund_reason === undefined ? {} : { refundReason: order.refund_reason }),
    ...(order.refund_amount === undefined ? {} : { refundAmount: order.refund_amount }),
    ...(order.attention === undefined ? {} : { attention: order.attention }),
  };
}

function assertProviderIdentity(recovery: SwapData, order: SwapOrder): void {
  if (
    order.provider !== recovery.providerOrder.provider ||
    order.provider_order_id !== recovery.providerOrder.provider_order_id
  ) {
    throw serviceError(502, "INTERNAL", "Swap provider returned a mismatched order.");
  }
}

function normalizePaymentHash(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw serviceError(400, "INVALID_REQUEST", "paymentHash is invalid.");
  }
  return normalized;
}

function normalizeOrderId(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 200) {
    throw serviceError(400, "INVALID_REQUEST", "orderId is invalid.");
  }
  return normalized;
}

function parsePayInAsset(value: string): SwapPayInAsset {
  if (!isOpenReceiveSwapPayInAsset(value)) {
    throw serviceError(400, "INVALID_REQUEST", "payInAsset is not supported.");
  }
  return value;
}

function normalizeRefundAddress(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 300) {
    throw serviceError(400, "INVALID_REQUEST", "refundAddress is invalid.");
  }
  return normalized;
}
