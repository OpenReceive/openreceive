import { isValidSwapAddressForPayInAsset } from "@openreceive/core";
import {
  type getSwapAssetInfo,
  isSwapPayInAsset,
  listSwapAssetInfo,
  type SwapOrder,
  type SwapPayInAsset,
  type SwapProvider,
  type SwapProviderAsset,
} from "../swap/index.ts";
import { createCheckout } from "./checkouts.ts";
import { ServiceError, serviceError } from "./core-utils.ts";
import { emitLog } from "./logging.ts";
import { createAmountRequest, normalizeCreateCheckoutAmount } from "./requests.ts";
import { resolveCreateAmount } from "./pricing.ts";
import type {
  CreateSwapRequest,
  GetSwapRequest,
  ListSwapOptionsRequest,
  ListSwapOptionsResult,
  ServiceContext,
  PublicSwap,
  SwapCheckout,
  SwapPaymentMethod,
  SwapQuoteRequest,
  SwapQuoteResult,
  SwapRefundRequest,
  SwapData,
} from "./types.ts";

export async function listSwapOptions(
  context: ServiceContext,
  input: ListSwapOptionsRequest,
): Promise<ListSwapOptionsResult> {
  const providers = context.swapProviders;
  if (providers.length === 0) {
    emitLog(
      context.options,
      "debug",
      "swap.options.resolved",
      "No swap providers configured; payment methods are Lightning-only.",
      { option_count: 0, available_count: 0 },
    );
    return { enabled: false, options: [] };
  }

  const amountMsats = parseAmountMsats(input.amountMsats);
  const providerCatalog = await resolveSwapProviderCatalog(context, providers);
  const options = listSwapAssetInfo().map((asset) =>
    swapCatalogOption({
      asset,
      amountMsats,
      providerAsset: providerCatalog.get(asset.pay_in_asset),
    }),
  );
  const unavailableOptions = options.filter((option) => !option.available);
  emitLog(
    context.options,
    "debug",
    "swap.options.resolved",
    "Resolved swap pay options with availability.",
    {
      amount_msats: amountMsats,
      option_count: options.length,
      available_count: options.length - unavailableOptions.length,
      unavailable_count: unavailableOptions.length,
      pay_in_assets: options.map((option) => option.payInAsset),
      unavailable: unavailableOptions.map((option) => ({
        pay_in_asset: option.payInAsset,
        reason: option.unavailableReason,
      })),
    },
  );
  return { enabled: true, options };
}

export async function quoteSwap(
  context: ServiceContext,
  input: SwapQuoteRequest,
): Promise<SwapQuoteResult> {
  const amount = normalizeCreateCheckoutAmount(input.amount);
  const payInAsset = parsePayInAsset(input.payInAsset);
  const resolved = await resolveCreateAmount({
    body: createAmountRequest(amount),
    now: context.clock(),
    priceProviders: context.priceProviders,
    priceCurrencies: context.priceCurrencies,
  });
  const provider = await selectProvider(context, payInAsset);
  const quote = await provider.quote({ payInAsset, invoiceAmountMsats: resolved.amountMsats });
  return {
    provider: quote.provider,
    payAsset: quote.pay_asset,
    available: quote.available,
    ...(quote.pay_amount === undefined ? {} : { payAmount: quote.pay_amount }),
    ...(quote.minimum_pay_amount === undefined
      ? {}
      : { minimumPayAmount: quote.minimum_pay_amount }),
    ...(quote.maximum_pay_amount === undefined
      ? {}
      : { maximumPayAmount: quote.maximum_pay_amount }),
    ...(quote.minimum_invoice_amount_msats === undefined
      ? {}
      : { minimumInvoiceAmountMsats: quote.minimum_invoice_amount_msats }),
    ...(quote.maximum_invoice_amount_msats === undefined
      ? {}
      : { maximumInvoiceAmountMsats: quote.maximum_invoice_amount_msats }),
    ...(quote.unavailable_reason === undefined
      ? {}
      : { unavailableReason: quote.unavailable_reason }),
    ...(quote.unavailable_message === undefined
      ? {}
      : { unavailableMessage: quote.unavailable_message }),
  };
}

export async function createSwap(
  context: ServiceContext,
  input: CreateSwapRequest,
): Promise<SwapCheckout> {
  const payInAsset = parsePayInAsset(input.payInAsset);
  const provider = await selectProvider(context, payInAsset);
  const expirySeconds = provider.invoiceExpirySeconds?.({ payInAsset });
  // Strip the swap-only field: the checkout normalizer accepts exactly the
  // declared CreateCheckoutRequest fields.
  const { payInAsset: _payInAsset, ...checkoutRequest } = input;
  const checkout = await createCheckout(context, { ...checkoutRequest, expirySeconds });
  const order = await provider.createSwap({
    payInAsset,
    bolt11: checkout.bolt11,
    invoiceAmountMsats: checkout.amountMsats,
  });
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

export async function getSwap(context: ServiceContext, input: GetSwapRequest): Promise<PublicSwap> {
  const recovery = parseSwapData(input.swapData);
  const paymentHash = parsePaymentHash(input.paymentHash);
  const orderId = parseOrderId(input.orderId);
  const provider = requireProvider(context, recovery.providerOrder.provider);
  const current = await provider.getStatus(recovery.providerOrder);
  return publicSwap(current, paymentHash, orderId);
}

export async function refundSwap(
  context: ServiceContext,
  input: SwapRefundRequest,
): Promise<PublicSwap> {
  const recovery = parseSwapData(input.swapData);
  const paymentHash = parsePaymentHash(input.paymentHash);
  const orderId = parseOrderId(input.orderId);
  const refundAddress = parseRefundAddress(
    input.refundAddress,
    recovery.providerOrder.pay_in_asset,
  );
  const provider = requireProvider(context, recovery.providerOrder.provider);
  const current = await provider.getStatus(recovery.providerOrder);
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
  context: ServiceContext,
  payInAsset: SwapPayInAsset,
): Promise<SwapProvider> {
  const providers = context.swapProviders;
  if (providers.length === 0) {
    throw serviceError(503, "INTERNAL", `No configured swap provider supports ${payInAsset}.`);
  }

  // Primary-only while healthy. Backup is consulted only when primary is down
  // (throws), never to fill gaps for assets the primary simply does not list.
  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index];
    if (provider === undefined) continue;
    try {
      const supported = await provider.supportedPayInAssets();
      if (supported.has(payInAsset)) {
        if (index > 0) {
          emitLog(
            context.options,
            "warn",
            "swap.provider.failover",
            "Primary swap provider unavailable; using backup.",
            {
              provider: provider.name,
              pay_in_asset: payInAsset,
              failed_providers: providers.slice(0, index).map((entry) => entry.name),
            },
          );
        }
        return provider;
      }
      // Healthy provider that omits this asset — do not fall through to backup.
      throw serviceError(503, "INTERNAL", `No configured swap provider supports ${payInAsset}.`);
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      // Provider request failed — try the next configured LSC connection.
    }
  }
  throw serviceError(503, "INTERNAL", `No configured swap provider supports ${payInAsset}.`);
}

function requireProvider(context: ServiceContext, name: string): SwapProvider {
  const provider = context.swapProviders.find((candidate) => candidate.name === name);
  if (provider === undefined) {
    throw serviceError(503, "INTERNAL", `Swap provider ${name} is not configured.`);
  }
  return provider;
}

function parseSwapData(value: SwapData): SwapData {
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
    ...(order.attention_reason === undefined ? {} : { attentionReason: order.attention_reason }),
    ...(order.deposit_received_amount === undefined
      ? {}
      : { depositReceivedAmount: order.deposit_received_amount }),
    ...(order.emergency_repeat === undefined ? {} : { emergencyRepeat: order.emergency_repeat }),
    providerOrderId: order.provider_order_id,
    ...(order.fee === undefined ? {} : { fee: order.fee }),
  };
}

function parsePaymentHash(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw serviceError(400, "INVALID_REQUEST", "paymentHash is invalid.");
  }
  return normalized;
}

function parseOrderId(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 200) {
    throw serviceError(400, "INVALID_REQUEST", "orderId is invalid.");
  }
  return normalized;
}

function parsePayInAsset(value: string): SwapPayInAsset {
  if (!isSwapPayInAsset(value)) {
    throw serviceError(400, "INVALID_REQUEST", "payInAsset is not supported.");
  }
  return value;
}

/**
 * A refund is the last chance to recover a mis-sent deposit, so the address is
 * checked against the order's own pay-in network with its checksum — a false
 * accept here sends the payer's money somewhere unrecoverable.
 */
function parseRefundAddress(value: string, payInAsset: unknown): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 300) {
    throw serviceError(400, "INVALID_REQUEST", "refundAddress is invalid.");
  }
  if (typeof payInAsset === "string" && !isValidSwapAddressForPayInAsset(payInAsset, normalized)) {
    throw serviceError(
      400,
      "INVALID_REQUEST",
      `refundAddress is not a valid ${payInAsset} address.`,
    );
  }
  return normalized;
}

function parseAmountMsats(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1000) {
    throw serviceError(400, "INVALID_REQUEST", "amountMsats must be an integer >= 1000.");
  }
  // Lightning invoices are whole sats; round up so catalog limits match create.
  return Math.ceil(value / 1000) * 1000;
}

async function resolveSwapProviderCatalog(
  context: ServiceContext,
  providers: readonly SwapProvider[],
): Promise<Map<SwapPayInAsset, SwapProviderAsset & { readonly provider: string }>> {
  // Use exactly one live provider: primary when healthy, otherwise the first
  // backup that answers. Do not merge catalogs across providers.
  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index];
    if (provider === undefined) continue;
    let catalog: readonly SwapProviderAsset[];
    try {
      catalog =
        provider.payInAssetCatalog === undefined
          ? Array.from(await provider.supportedPayInAssets(), (payInAsset) => ({
              pay_asset: payInAsset,
            }))
          : await provider.payInAssetCatalog();
    } catch {
      // Catalog/rates feed down for this provider — try the next configured entry.
      continue;
    }
    if (index > 0) {
      emitLog(
        context.options,
        "warn",
        "swap.provider.failover",
        "Primary swap provider unavailable; using backup.",
        {
          provider: provider.name,
          failed_providers: providers.slice(0, index).map((entry) => entry.name),
        },
      );
    }
    const byAsset = new Map<SwapPayInAsset, SwapProviderAsset & { readonly provider: string }>();
    for (const item of catalog) {
      byAsset.set(item.pay_asset, {
        ...item,
        provider: provider.name,
      });
    }
    return byAsset;
  }
  return new Map();
}

function swapCatalogOption(input: {
  readonly asset: ReturnType<typeof getSwapAssetInfo>;
  readonly amountMsats: number;
  readonly providerAsset?: SwapProviderAsset & { readonly provider: string };
}): SwapPaymentMethod {
  const { asset, amountMsats, providerAsset } = input;
  if (providerAsset === undefined) {
    return {
      payInAsset: asset.pay_in_asset,
      label: asset.label,
      networkLabel: asset.network_label,
      provider: "",
      available: false,
      unavailableReason: "provider_unconfigured",
      unavailableMessage: "Automated swaps are not configured for this asset.",
    };
  }

  const limitReason =
    amountMsats > 0 &&
    providerAsset.minimum_invoice_amount_msats !== undefined &&
    amountMsats < providerAsset.minimum_invoice_amount_msats
      ? "amount_too_small"
      : amountMsats > 0 &&
          providerAsset.maximum_invoice_amount_msats !== undefined &&
          amountMsats > providerAsset.maximum_invoice_amount_msats
        ? "amount_too_large"
        : undefined;
  const unavailableReason =
    limitReason ??
    (providerAsset.available === false ? providerAsset.unavailable_reason : undefined);
  const unavailableMessage =
    limitReason === "amount_too_small"
      ? "This invoice is below the provider minimum."
      : limitReason === "amount_too_large"
        ? "This invoice is above the provider maximum."
        : providerAsset.available === false
          ? providerAsset.unavailable_message
          : undefined;

  return {
    payInAsset: asset.pay_in_asset,
    label: asset.label,
    networkLabel: asset.network_label,
    provider: providerAsset.provider,
    available: unavailableReason === undefined && providerAsset.available !== false,
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
    ...(unavailableMessage === undefined ? {} : { unavailableMessage }),
    ...(providerAsset.minimum_pay_amount === undefined
      ? {}
      : { minimumPayAmount: providerAsset.minimum_pay_amount }),
    ...(providerAsset.maximum_pay_amount === undefined
      ? {}
      : { maximumPayAmount: providerAsset.maximum_pay_amount }),
    ...(providerAsset.minimum_invoice_amount_msats === undefined
      ? {}
      : { minimumInvoiceAmountMsats: providerAsset.minimum_invoice_amount_msats }),
    ...(providerAsset.maximum_invoice_amount_msats === undefined
      ? {}
      : { maximumInvoiceAmountMsats: providerAsset.maximum_invoice_amount_msats }),
  };
}
