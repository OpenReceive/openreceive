import { createHash } from "node:crypto";
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
  CreateSwapRefundConfirmationRequest,
  CreateSwapRequest,
  GetSwapRequest,
  OpenReceiveServiceContext,
  PublicSwap,
  SwapCheckout,
  SwapQuoteRequest,
  SwapRefundConfirmation,
  SwapRefundRequest,
  SwapStatus,
} from "./types.ts";

interface SwapRecoveryPayload {
  readonly version: 1;
  readonly issuedAt: number;
  readonly expiresAt?: number;
  readonly provider: string;
  readonly providerOrder: SwapOrder;
  readonly paymentHash: string;
  readonly orderId: string;
}

interface RefundConfirmationPayload {
  readonly version: 1;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly recoveryDigest: string;
  readonly paymentHash: string;
  readonly providerOrderId: string;
  readonly refundAddress: string;
}

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
  const swapRecoveryToken = context.tokenManager.seal("swap", {
    provider: provider.name,
    providerOrder: recoveryOrder(order),
    paymentHash: checkout.paymentHash,
    orderId: checkout.orderId,
  });
  return {
    checkout,
    swapRecoveryToken,
    ...publicSwap(order, checkout.paymentHash, checkout.orderId),
  };
}

export async function getSwap(
  context: OpenReceiveServiceContext,
  input: GetSwapRequest,
): Promise<SwapStatus> {
  const recovery = openRecovery(context, input.recoveryToken);
  const provider = requireProvider(context, recovery.provider);
  const current = await provider.getStatus(recovery.providerOrder);
  assertProviderIdentity(recovery, current);
  return {
    swapRecoveryToken: input.recoveryToken,
    ...publicSwap(current, recovery.paymentHash, recovery.orderId),
  };
}

export async function createSwapRefundConfirmation(
  context: OpenReceiveServiceContext,
  input: CreateSwapRefundConfirmationRequest,
): Promise<SwapRefundConfirmation> {
  const recovery = openRecovery(context, input.recoveryToken);
  const refundAddress = normalizeRefundAddress(input.refundAddress);
  const ttlSeconds = input.ttlSeconds ?? 10 * 60;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > 60 * 60) {
    throw serviceError(400, "INVALID_REQUEST", "ttlSeconds must be between 1 and 3600.");
  }
  const expiresAt = context.clock() + ttlSeconds;
  return {
    expiresAt,
    confirmationToken: context.tokenManager.seal("confirm", {
      expiresAt,
      recoveryDigest: digest(input.recoveryToken),
      paymentHash: recovery.paymentHash,
      providerOrderId: recovery.providerOrder.provider_order_id,
      refundAddress,
    }),
  };
}

export async function refundSwap(
  context: OpenReceiveServiceContext,
  input: SwapRefundRequest,
): Promise<SwapStatus> {
  const recovery = openRecovery(context, input.recoveryToken);
  const confirmation = context.tokenManager.open<RefundConfirmationPayload>(
    "confirm",
    input.confirmationToken,
  );
  const refundAddress = normalizeRefundAddress(input.refundAddress);
  if (
    confirmation.recoveryDigest !== digest(input.recoveryToken) ||
    confirmation.paymentHash !== recovery.paymentHash ||
    confirmation.providerOrderId !== recovery.providerOrder.provider_order_id ||
    confirmation.refundAddress !== refundAddress
  ) {
    throw serviceError(400, "INVALID_REQUEST", "Refund confirmation does not match this request.");
  }
  const provider = requireProvider(context, recovery.provider);
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
  return {
    swapRecoveryToken: input.recoveryToken,
    ...publicSwap(refreshed, recovery.paymentHash, recovery.orderId),
  };
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

function openRecovery(
  context: OpenReceiveServiceContext,
  token: string,
): SwapRecoveryPayload {
  const payload = context.tokenManager.open<SwapRecoveryPayload>("swap", token);
  if (
    typeof payload.provider !== "string" ||
    typeof payload.paymentHash !== "string" ||
    typeof payload.orderId !== "string" ||
    typeof payload.providerOrder !== "object" ||
    payload.providerOrder === null
  ) {
    throw serviceError(400, "INVALID_REQUEST", "Swap recovery token has an invalid payload.");
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

function assertProviderIdentity(recovery: SwapRecoveryPayload, order: SwapOrder): void {
  if (
    order.provider !== recovery.provider ||
    order.provider_order_id !== recovery.providerOrder.provider_order_id
  ) {
    throw serviceError(502, "INTERNAL", "Swap provider returned a mismatched order.");
  }
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

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}
