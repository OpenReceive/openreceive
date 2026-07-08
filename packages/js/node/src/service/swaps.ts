import {
  createIdempotencyRequestHash,
  type InvoiceStorageRow,
  putCreatedInvoiceRecord,
  type StoredRecord,
  sweepPendingInvoicesOnce,
} from "@openreceive/core";
import {
  formatOpenReceiveSwapAssetLabel,
  getOpenReceiveSwapAssetInfo,
  isOpenReceiveSwapPayInAsset,
  isOpenReceiveSwapTerminalState,
  isValidSwapAddressForNetwork,
  listOpenReceiveSwapAssetInfo,
  StoreBackedSwapCache,
  type OpenReceiveSwapOrder,
  type OpenReceiveSwapPayInAsset,
  type OpenReceiveSwapProvider,
  type OpenReceiveSwapProviderAsset,
  type OpenReceiveSwapQuote,
} from "../swap/index.ts";
import {
  asRecord,
  createStoredInvoiceId,
  optionalSafeInteger,
  optionalString,
  readOpenReceiveNamespace,
  serviceError,
  toSafeInteger,
} from "./core-utils.ts";
import { emitLog, invoiceLogFields } from "./logging.ts";
import {
  createSwapRefundNonce,
  currentOpenCheckout,
  groupCheckouts,
  parseSwapMetadata,
  parseSwapPrivateMetadata,
  readInvoiceRail,
  readStoredSwapLastPolledAt,
  readStoredSwapOrder,
  readStoredSwapPayInAsset,
  readStoredSwapState,
  serializeInvoice,
  storedSwapHasProviderOrder,
  swapBaseMetadata,
  swapMetadataFromProviderOrder,
  swapPrivateMetadataFromProviderOrder,
  withSwapRefundFreshness,
} from "./models.ts";
import { reconcileOptions } from "./reconcile.ts";
import { getCreateDescriptionFields, parseGetOrderId, parseOrderId } from "./requests.ts";
import type {
  OpenReceiveInvoiceModel,
  OpenReceiveServiceContext,
  OpenReceiveSwapOption,
  OpenReceiveSwapOptionsRequest,
  OpenReceiveSwapOptionsResponse,
  OpenReceiveSwapQuoteRequest,
  OpenReceiveSwapQuoteResponse,
  OpenReceiveSwapRefundRequest,
  OpenReceiveSwapStartRequest,
} from "./types.ts";

export const OPENRECEIVE_SWAP_CREATING_TIMEOUT_SECONDS = 30;

export const OPENRECEIVE_SWAP_SETTLEMENT_ATTENTION_SECONDS = 60;

export const OPENRECEIVE_SWAP_QUOTE_CACHE_SECONDS = 15;

export async function getSwapOptions(
  context: OpenReceiveServiceContext,
  input: OpenReceiveSwapOptionsRequest,
): Promise<OpenReceiveSwapOptionsResponse> {
  const providers = context.swapProviders;
  if (providers.length === 0) {
    return {
      enabled: false,
      options: [],
    };
  }

  const orderId = parseGetOrderId(input);
  const records = await context.store.listByOrderId(orderId);
  if (records.length === 0) {
    throw serviceError(404, "NOT_FOUND", "No order found for the given order_id.");
  }

  const checkout = currentOpenCheckout(groupCheckouts(records, context.clock()));
  if (checkout === undefined) {
    return {
      enabled: true,
      options: [],
    };
  }

  const providerCatalog = await resolveSwapProviderCatalog(providers);
  const providerByName = new Map(providers.map((provider) => [provider.name, provider]));
  const amountMsats = roundMsatsUpToWholeSats(checkout.amountMsats);

  // The /ccies catalog carries no amount limits; a provider only exposes per-pair
  // min/max via a /price quote (FixedFloat: data.to.min/max, the invoice-side BTC
  // limits). Those limits are slow-changing (fee/dust driven), so they're cached in
  // the durable store per (provider, pay-in asset) for 14 days and the fixed invoice
  // amount is gated LOCALLY. This keeps the payment-method screen off /price entirely
  // once the cache is warm — only a cold/expired pair triggers a single quote, shared
  // across every checkout and instance via the store.
  const pairLimitsCache = new StoreBackedSwapCache(context.store, context.clock, {
    warn: (message, fields) =>
      emitLog(context.options, "warn", "swap.pair_limits.stale", message, fields),
  });
  const options = await Promise.all(
    listOpenReceiveSwapAssetInfo().map(async (asset) => {
      const providerAsset = providerCatalog.get(asset.pay_in_asset);
      if (providerAsset === undefined) {
        return swapCatalogOption({ asset, amountMsats, providerAsset: undefined });
      }
      const provider = providerByName.get(providerAsset.provider);
      let limits: SwapPairLimits = {};
      if (provider !== undefined) {
        try {
          limits = await pairLimitsCache.resolve(
            swapPairLimitsKey(provider.name, asset.pay_in_asset),
            {
              refreshSeconds: SWAP_PAIR_LIMITS_REFRESH_SECONDS,
              maxStaleSeconds: SWAP_PAIR_LIMITS_MAX_STALE_SECONDS,
              fetch: () => fetchSwapPairLimits(provider, asset.pay_in_asset),
              serialize: (value) => JSON.stringify(value),
              deserialize: parseSwapPairLimits,
            },
          );
        } catch (error) {
          // Fail open: an unreachable provider or an unlimited pair leaves the asset
          // selectable rather than greying it out on a soft error.
          emitLog(
            context.options,
            "warn",
            "swap.pair_limits.failed",
            "Swap pair limits lookup failed; leaving asset available.",
            {
              order_id: orderId,
              pay_in_asset: asset.pay_in_asset,
              provider: provider.name,
              error_message: error instanceof Error ? error.message : String(error),
            },
          );
        }
      }
      // Gate the fixed invoice amount against the cached per-pair limits locally.
      return swapCatalogOption({
        asset,
        amountMsats,
        providerAsset: { ...providerAsset, ...limits },
      });
    }),
  );

  // Diagnostic: how availability resolved per asset for this invoice amount. Remove
  // once the disabled-asset behavior is confirmed against the live provider.
  emitLog(
    context.options,
    "info",
    "swap.options.resolved",
    "Resolved swap pay options with availability.",
    {
      order_id: orderId,
      amount_msats: amountMsats,
      options: options.map((option) => ({
        pay_in_asset: option.pay_in_asset,
        available: option.available,
        unavailable_reason: option.unavailable_reason,
        minimum_invoice_amount_msats: option.minimum_invoice_amount_msats,
        maximum_invoice_amount_msats: option.maximum_invoice_amount_msats,
        minimum_pay_amount: option.minimum_pay_amount,
        maximum_pay_amount: option.maximum_pay_amount,
      })),
    },
  );

  return {
    enabled: true,
    options,
  };
}

export async function quoteSwap(
  context: OpenReceiveServiceContext,
  input: OpenReceiveSwapQuoteRequest,
): Promise<OpenReceiveSwapQuoteResponse> {
  const body = asRecord(input);
  const orderId = parseOrderId(body);
  const payInAsset = parseSwapPayInAsset(body.payInAsset);
  const providers = context.swapProviders;
  if (providers.length === 0) {
    return swapCatalogOption({
      asset: getOpenReceiveSwapAssetInfo(payInAsset),
      amountMsats: 0,
      providerAsset: undefined,
    });
  }

  const records = await context.store.listByOrderId(orderId);
  if (records.length === 0) {
    throw serviceError(404, "NOT_FOUND", "No order found for the given order_id.");
  }
  const checkout = currentOpenCheckout(groupCheckouts(records, context.clock()));
  if (checkout === undefined) {
    throw serviceError(409, "CONFLICT", "Order has no open checkout to quote a swap.");
  }

  const provider = await selectSwapProvider(providers, payInAsset);
  if (provider === undefined) {
    return swapCatalogOption({
      asset: getOpenReceiveSwapAssetInfo(payInAsset),
      amountMsats: roundMsatsUpToWholeSats(checkout.amountMsats),
      providerAsset: undefined,
    });
  }

  const amountMsats = roundMsatsUpToWholeSats(checkout.amountMsats);
  return await resolveCachedSwapQuote(context, checkout.checkoutId, provider, payInAsset, amountMsats);
}

// Quotes a pay-in asset at the invoice amount, served from a short-lived durable
// (store-backed, not process memory) cache so repeated status polls and the catalog
// screen don't re-hit the provider's /price endpoint within the cache window.
async function resolveCachedSwapQuote(
  context: OpenReceiveServiceContext,
  checkoutId: string,
  provider: OpenReceiveSwapProvider,
  payInAsset: OpenReceiveSwapPayInAsset,
  amountMsats: number,
): Promise<OpenReceiveSwapOption> {
  const now = context.clock();
  const quoteCacheKey = swapQuoteMetaKey(checkoutId, payInAsset);
  const cachedMeta = await context.store.getMeta(quoteCacheKey);
  const cached = parseCachedSwapQuote(cachedMeta?.value);
  if (cached !== undefined && cached.amountMsats === amountMsats && cached.expiresAt > now) {
    return cached.quote;
  }

  const quote = await provider.quote({
    payInAsset,
    invoiceAmountMsats: amountMsats,
  });
  const response = swapQuoteOption({
    asset: getOpenReceiveSwapAssetInfo(payInAsset),
    quote,
  });
  // Best-effort write: a concurrent writer winning the CAS just means another
  // instance already cached an equivalent quote, so we still return ours.
  await context.store.casMeta(
    quoteCacheKey,
    JSON.stringify({
      amountMsats,
      expiresAt: now + OPENRECEIVE_SWAP_QUOTE_CACHE_SECONDS,
      quote: response,
    } satisfies CachedSwapQuoteEntry),
    cachedMeta === undefined ? null : cachedMeta.rev,
  );
  return response;
}

interface CachedSwapQuoteEntry {
  readonly amountMsats: number;
  readonly expiresAt: number;
  readonly quote: OpenReceiveSwapQuoteResponse;
}

function swapQuoteMetaKey(checkoutId: string, payInAsset: OpenReceiveSwapPayInAsset): string {
  return `swap_quote:${checkoutId}:${payInAsset}`;
}

function parseCachedSwapQuote(value: string | undefined): CachedSwapQuoteEntry | undefined {
  if (value === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.amountMsats !== "number" ||
    typeof record.expiresAt !== "number" ||
    record.quote === null ||
    typeof record.quote !== "object"
  ) {
    return undefined;
  }
  return {
    amountMsats: record.amountMsats,
    expiresAt: record.expiresAt,
    quote: record.quote as OpenReceiveSwapQuoteResponse,
  };
}

// Per-pair min/max limits change slowly (fee/dust driven), so cache them for 14 days
// and serve them stale up to 30 days if the provider is briefly unreachable.
const SWAP_PAIR_LIMITS_REFRESH_SECONDS = 14 * 24 * 60 * 60;
const SWAP_PAIR_LIMITS_MAX_STALE_SECONDS = 30 * 24 * 60 * 60;
// Nominal in-range probe amount (0.005 BTC) used only to read a pair's static limits;
// the provider returns min/max regardless of the probe amount.
const SWAP_PAIR_LIMITS_PROBE_MSATS = 500_000_000;

interface SwapPairLimits {
  readonly minimum_invoice_amount_msats?: number;
  readonly maximum_invoice_amount_msats?: number;
  readonly minimum_pay_amount?: string;
  readonly maximum_pay_amount?: string;
}

function swapPairLimitsKey(providerName: string, payInAsset: OpenReceiveSwapPayInAsset): string {
  return `swap_pair_limits:${providerName}:${payInAsset}`;
}

async function fetchSwapPairLimits(
  provider: OpenReceiveSwapProvider,
  payInAsset: OpenReceiveSwapPayInAsset,
): Promise<SwapPairLimits> {
  const quote = await provider.quote({
    payInAsset,
    invoiceAmountMsats: SWAP_PAIR_LIMITS_PROBE_MSATS,
  });
  return {
    ...(quote.minimum_invoice_amount_msats === undefined
      ? {}
      : { minimum_invoice_amount_msats: quote.minimum_invoice_amount_msats }),
    ...(quote.maximum_invoice_amount_msats === undefined
      ? {}
      : { maximum_invoice_amount_msats: quote.maximum_invoice_amount_msats }),
    ...(quote.minimum_pay_amount === undefined
      ? {}
      : { minimum_pay_amount: quote.minimum_pay_amount }),
    ...(quote.maximum_pay_amount === undefined
      ? {}
      : { maximum_pay_amount: quote.maximum_pay_amount }),
  };
}

function parseSwapPairLimits(value: string): SwapPairLimits {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object") return {};
  const record = parsed as Record<string, unknown>;
  return {
    ...(typeof record.minimum_invoice_amount_msats === "number"
      ? { minimum_invoice_amount_msats: record.minimum_invoice_amount_msats }
      : {}),
    ...(typeof record.maximum_invoice_amount_msats === "number"
      ? { maximum_invoice_amount_msats: record.maximum_invoice_amount_msats }
      : {}),
    ...(typeof record.minimum_pay_amount === "string"
      ? { minimum_pay_amount: record.minimum_pay_amount }
      : {}),
    ...(typeof record.maximum_pay_amount === "string"
      ? { maximum_pay_amount: record.maximum_pay_amount }
      : {}),
  };
}

export async function startSwap(
  context: OpenReceiveServiceContext,
  input: OpenReceiveSwapStartRequest,
): Promise<OpenReceiveInvoiceModel> {
  const body = asRecord(input);
  const orderId = parseOrderId(body);
  const payInAsset = parseSwapPayInAsset(body.payInAsset);
  const now = context.clock();
  const records = await context.store.listByOrderId(orderId);
  if (records.length === 0) {
    throw serviceError(404, "NOT_FOUND", "No order found for the given order_id.");
  }

  await sweepPendingInvoicesOnce(reconcileOptions(context));
  await advanceSwapsForRecords(context, records);
  const freshRecords = await context.store.listByOrderId(orderId);
  const checkouts = groupCheckouts(freshRecords, now);
  const paidCheckout = checkouts.find((checkout) => checkout.status === "paid");
  if (paidCheckout !== undefined) {
    throw serviceError(409, "CONFLICT", "Order is already paid.");
  }

  const checkout = currentOpenCheckout(checkouts);
  if (checkout === undefined) {
    throw serviceError(409, "CONFLICT", "Order has no open checkout to start a swap.");
  }
  if (checkout.active === undefined) {
    throw serviceError(409, "CONFLICT", "Open checkout has no Lightning invoice to swap.");
  }

  const checkoutRecords = await context.store.listByCheckoutId(checkout.checkoutId);
  const existing = findReusableSwapRecord(checkoutRecords, payInAsset, now);
  if (existing !== undefined) {
    if (readStoredSwapState(existing.row) === "creating_provider_order") {
      return await readReservedSwapAttemptForStartReplay(context, existing, now);
    }
    return serializeInvoice(existing.row, now);
  }

  const nonTerminalSwapCount = checkoutRecords.filter((record) =>
    isReusableSwapRecord(record, now),
  ).length;
  if (nonTerminalSwapCount >= 3) {
    throw serviceError(
      409,
      "CONFLICT",
      "Checkout already has three active swap attempts. Wait for one to expire before starting another.",
    );
  }

  const provider = await selectSwapProvider(context.swapProviders, payInAsset);
  if (provider === undefined) {
    throw serviceError(
      400,
      "INVALID_REQUEST",
      `${formatOpenReceiveSwapAssetLabel(payInAsset)} is not available for automated swaps.`,
    );
  }

  const displayRecord = checkoutRecords.find(
    (record) => record.row.invoice_id === checkout.active?.invoiceId,
  );
  if (displayRecord === undefined) {
    throw serviceError(500, "INTERNAL", "Active checkout invoice was not readable.");
  }

  const invoiceExpirySeconds = swapInvoiceExpirySeconds(provider, payInAsset);
  const roundedAmountMsats = roundMsatsUpToWholeSats(displayRecord.row.amount_msats);
  const walletInvoice = await context.options.client.makeInvoice({
    amount_msats: BigInt(roundedAmountMsats),
    ...getStoredDescriptionFields(displayRecord.row),
    expiry: invoiceExpirySeconds,
  });
  const createdAt = walletInvoice.created_at ?? context.clock();
  const expiresAt = walletInvoice.expires_at ?? createdAt + invoiceExpirySeconds;
  if (expiresAt - createdAt < invoiceExpirySeconds) {
    throw serviceError(
      500,
      "INTERNAL",
      "Swap shadow invoice expiry is shorter than the provider payout window.",
    );
  }
  const normalizedExpiresAt = Math.min(expiresAt, createdAt + invoiceExpirySeconds);
  const attemptNumber =
    checkoutRecords.filter((record) => readStoredSwapPayInAsset(record.row) === payInAsset).length +
    1;
  const swapAttemptKey = `${checkout.checkoutId}:swap:${payInAsset}:attempt:${attemptNumber}`;
  const requestHash = await createIdempotencyRequestHash({
    checkout_id: checkout.checkoutId,
    pay_in_asset: payInAsset,
    amount_msats: roundedAmountMsats,
    rail: "swap",
    attempt_number: attemptNumber,
  });
  const namespaceScope = context.options.namespace ?? readOpenReceiveNamespace(undefined);
  const operation = "invoice.create";
  const reserved = await putCreatedInvoiceRecord({
    store: context.store,
    createStoredInvoiceId,
    record: {
      rev: 0,
      row: {
        invoice_id: createStoredInvoiceId(),
        namespace: namespaceScope,
        operation,
        idempotency_key: swapAttemptKey,
        idempotency_request_hash: requestHash,
        payment_hash: walletInvoice.payment_hash,
        invoice: walletInvoice.invoice,
        amount_msats: toSafeInteger(walletInvoice.amount_msats, "amount_msats"),
        transaction_state: "pending",
        workflow_state: "invoice_created",
        settlement_action_state: "pending",
        created_at: createdAt,
        expires_at: normalizedExpiresAt,
        metadata: {
          ...swapBaseMetadata(displayRecord.row),
          rail: "swap",
          swap_attempt_key: swapAttemptKey,
          swap: {
            provider: provider.name,
            pay_in_asset: payInAsset,
            provider_state: "creating_provider_order",
            provider_expires_at: normalizedExpiresAt,
            created_at: now,
            last_polled_at: now,
          },
        },
        fiat_quote:
          displayRecord.row.fiat_quote === undefined
            ? null
            : structuredClone(displayRecord.row.fiat_quote),
      },
    },
  });

  if (reserved.status === "replayed") {
    return await readReservedSwapAttemptForStartReplay(context, reserved.record, now);
  }

  let providerOrder: OpenReceiveSwapOrder;
  try {
    providerOrder = await provider.createSwap({
      payInAsset,
      bolt11: walletInvoice.invoice,
      invoiceAmountMsats: toSafeInteger(walletInvoice.amount_msats, "amount_msats"),
    });
  } catch (error) {
    const failed = await updateSwapRecord(context, reserved.record, (swap) => ({
      ...swap,
      provider_state: "failed",
      attention: true,
      attention_reason: "provider_order_creation_failed",
      provider_error: error instanceof Error ? error.message : String(error),
      last_polled_at: context.clock(),
    }));
    emitLog(context.options, "warn", "swap.create.failed", "Swap provider order creation failed.", {
      ...invoiceLogFields(failed.row),
      order_id: orderId,
      checkout_id: checkout.checkoutId,
      provider: provider.name,
      pay_in_asset: payInAsset,
      error_message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  const finalized = await updateSwapRecordWithPrivate(context, reserved.record, (swap) => ({
    swap: {
      ...withSwapRefundFreshness(
        {
          ...swap,
          ...swapMetadataFromProviderOrder(providerOrder, now),
          created_at: optionalSafeInteger(swap.created_at) ?? now,
          last_polled_at: now,
        },
        providerOrder.state,
        now,
      ),
    },
    swapPrivate: swapPrivateMetadataFromProviderOrder(providerOrder),
  }));

  emitLog(context.options, "info", "swap.created", "Created automated swap invoice.", {
    ...invoiceLogFields(finalized.row),
    order_id: orderId,
    checkout_id: checkout.checkoutId,
    provider: provider.name,
    pay_in_asset: payInAsset,
    provider_order_id: providerOrder.provider_order_id,
  });

  return serializeInvoice(finalized.row, now);
}

export async function refundSwap(
  context: OpenReceiveServiceContext,
  input: OpenReceiveSwapRefundRequest,
): Promise<OpenReceiveInvoiceModel> {
  const body = asRecord(input);
  const attemptId = parseSwapAttemptId(body.attemptId);
  const refundAddress = optionalString(body.refundAddress);
  const refundNonce = optionalString(body.refundNonce);
  const confirm = body.confirm === true;
  if (refundAddress === undefined) {
    throw serviceError(400, "INVALID_REQUEST", "refund_address is required.");
  }
  if (refundNonce === undefined) {
    throw serviceError(400, "INVALID_REQUEST", "refund_nonce is required.");
  }

  const candidate = await context.store.get(attemptId);
  if (candidate === undefined) {
    throw serviceError(404, "NOT_FOUND", "No swap attempt found for this attempt_id.");
  }
  if (readInvoiceRail(candidate.row) !== "swap") {
    throw serviceError(400, "INVALID_REQUEST", "attempt_id must reference a swap attempt.");
  }
  const payInAsset = readStoredSwapPayInAsset(candidate.row);
  if (payInAsset === undefined) {
    throw serviceError(500, "INTERNAL", "Stored swap attempt is missing its asset.");
  }
  assertRefundAddressShape(payInAsset, refundAddress);
  if (readStoredSwapState(candidate.row) !== "refund_required") {
    throw serviceError(409, "CONFLICT", "Swap attempt does not require a refund.");
  }
  assertRefundNonce(candidate.row, refundNonce, context.clock());

  if (!confirm) {
    return await stageRefundAddress(context, candidate, {
      attemptId,
      payInAsset,
      refundAddress,
    });
  }

  const stagedRefundAddress = optionalString(parseSwapMetadata(candidate.row)?.refund_address);
  if (stagedRefundAddress !== refundAddress) {
    throw serviceError(
      409,
      "CONFLICT",
      "Submit this refund address before confirming the provider refund.",
    );
  }

  const order = readStoredSwapOrder(candidate.row);
  const provider = context.swapProviders.find((item) => item.name === order.provider);
  if (provider === undefined) {
    throw serviceError(503, "INTERNAL", "Swap provider is unavailable.");
  }

  const now = context.clock();
  const dispatchId = createSwapRefundNonce();
  const locked = await updateSwapRecord(context, candidate, (swap) => {
    if (
      optionalString(swap.provider_state) !== "refund_required" ||
      optionalString(swap.refund_nonce) !== refundNonce ||
      optionalString(swap.refund_address) !== refundAddress
    ) {
      return swap;
    }
    return withSwapRefundFreshness(
      {
        ...swap,
        provider_state: "refund_pending",
        refund_address: refundAddress,
        refund_confirmed_at: now,
        refund_dispatch_id: dispatchId,
        last_polled_at: now,
      },
      "refund_pending",
      now,
    );
  });
  const lockedSwap = parseSwapMetadata(locked.row);
  if (
    readStoredSwapState(locked.row) !== "refund_pending" ||
    optionalString(lockedSwap?.refund_dispatch_id) !== dispatchId
  ) {
    throw serviceError(409, "CONFLICT", "Swap refund was already confirmed or changed.");
  }

  try {
    await provider.requestRefund(order, refundAddress);
  } catch (error) {
    await updateSwapRecord(context, locked, (swap) => {
      if (optionalString(swap.refund_dispatch_id) !== dispatchId) return swap;
      return withSwapRefundFreshness(
        {
          ...swap,
          provider_state: "refund_required",
          provider_error: error instanceof Error ? error.message : String(error),
          last_polled_at: context.clock(),
        },
        "refund_required",
        context.clock(),
      );
    });
    throw error;
  }

  emitLog(context.options, "info", "swap.refund.confirmed", "Confirmed automated swap refund.", {
    ...invoiceLogFields(locked.row),
    provider: order.provider,
    provider_order_id: order.provider_order_id,
    pay_in_asset: payInAsset,
  });
  return serializeInvoice(locked.row, now);
}

export async function advanceSwapsForOrder(
  context: OpenReceiveServiceContext,
  orderId: string,
): Promise<void> {
  if (context.swapProviders.length === 0) return;
  await advanceSwapsForRecords(context, await context.store.listByOrderId(orderId));
}

export async function advanceSwapsForRecords(
  context: OpenReceiveServiceContext,
  records: readonly StoredRecord[],
): Promise<void> {
  if (context.swapProviders.length === 0) return;
  const now = context.clock();
  const candidates = records
    .filter((record) => shouldPollSwapRecord(record, now))
    .sort((left, right) => left.row.created_at - right.row.created_at);

  for (const record of candidates) {
    const order = readStoredSwapOrder(record.row);
    const provider = context.swapProviders.find((item) => item.name === order.provider);
    if (provider === undefined) continue;

    try {
      const previousSwap = parseSwapMetadata(record.row) ?? {};
      const updatedOrder = await provider.getStatus(order);
      const nextState = updatedOrder.state;
      const providerCompletedAt =
        optionalSafeInteger(previousSwap.provider_completed_at) ??
        (nextState === "completed" ? now : undefined);
      const updatedRecord = await updateSwapRecord(context, record, (swap) => ({
        ...withSwapRefundFreshness(
          {
            ...swap,
            ...swapMetadataFromProviderOrder(updatedOrder, now),
            ...(providerCompletedAt === undefined
              ? {}
              : { provider_completed_at: providerCompletedAt }),
            last_polled_at: now,
          },
          updatedOrder.state,
          now,
        ),
      }));
      if (nextState === "completed" && providerCompletedAt !== undefined) {
        const latest = (await context.store.get(updatedRecord.row.invoice_id)) ?? updatedRecord;
        if (
          latest.row.transaction_state !== "settled" &&
          now - providerCompletedAt >= swapSettlementAttentionSeconds(context)
        ) {
          await updateSwapRecord(context, latest, (swap) => ({
            ...swap,
            provider_state: "attention",
            attention: true,
            attention_reason: "provider_completed_without_wallet_settlement",
            last_polled_at: now,
          }));
        }
      }
    } catch (error) {
      emitLog(
        context.options,
        "warn",
        "swap.status.failed",
        "Swap provider status refresh failed.",
        {
          invoice_id: record.row.invoice_id,
          provider: order.provider,
          provider_order_id: order.provider_order_id,
          error_message: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }
}

export async function resolveSwapProviderCatalog(
  providers: readonly OpenReceiveSwapProvider[],
): Promise<
  Map<OpenReceiveSwapPayInAsset, OpenReceiveSwapProviderAsset & { readonly provider: string }>
> {
  const byAsset = new Map<
    OpenReceiveSwapPayInAsset,
    OpenReceiveSwapProviderAsset & { readonly provider: string }
  >();
  for (const provider of providers) {
    const catalog =
      provider.payInAssetCatalog === undefined
        ? Array.from(await provider.supportedPayInAssets(), (payInAsset) => ({
            pay_asset: payInAsset,
          }))
        : await provider.payInAssetCatalog();
    for (const item of catalog) {
      if (!byAsset.has(item.pay_asset)) {
        byAsset.set(item.pay_asset, {
          ...item,
          provider: provider.name,
        });
      }
    }
  }
  return byAsset;
}

export function swapCatalogOption(input: {
  readonly asset: ReturnType<typeof getOpenReceiveSwapAssetInfo>;
  readonly amountMsats: number;
  readonly providerAsset?: OpenReceiveSwapProviderAsset & { readonly provider: string };
}): OpenReceiveSwapOption {
  const { asset, amountMsats, providerAsset } = input;
  if (providerAsset === undefined) {
    return {
      pay_in_asset: asset.pay_in_asset,
      label: asset.label,
      network_label: asset.network_label,
      provider: "",
      available: false,
      unavailable_reason: "provider_unconfigured",
      unavailable_message: "Automated swaps are not configured for this asset.",
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
    pay_in_asset: asset.pay_in_asset,
    label: asset.label,
    network_label: asset.network_label,
    provider: providerAsset.provider,
    available: unavailableReason === undefined && providerAsset.available !== false,
    ...(unavailableReason === undefined ? {} : { unavailable_reason: unavailableReason }),
    ...(unavailableMessage === undefined ? {} : { unavailable_message: unavailableMessage }),
    ...(providerAsset.minimum_pay_amount === undefined
      ? {}
      : { minimum_pay_amount: providerAsset.minimum_pay_amount }),
    ...(providerAsset.maximum_pay_amount === undefined
      ? {}
      : { maximum_pay_amount: providerAsset.maximum_pay_amount }),
    ...(providerAsset.minimum_invoice_amount_msats === undefined
      ? {}
      : { minimum_invoice_amount_msats: providerAsset.minimum_invoice_amount_msats }),
    ...(providerAsset.maximum_invoice_amount_msats === undefined
      ? {}
      : { maximum_invoice_amount_msats: providerAsset.maximum_invoice_amount_msats }),
  };
}

export function swapQuoteOption(input: {
  readonly asset: ReturnType<typeof getOpenReceiveSwapAssetInfo>;
  readonly quote: OpenReceiveSwapQuote;
}): OpenReceiveSwapOption {
  const { asset, quote } = input;
  return {
    pay_in_asset: asset.pay_in_asset,
    label: asset.label,
    network_label: asset.network_label,
    provider: quote.provider,
    available: quote.available,
    ...(quote.unavailable_reason === undefined
      ? {}
      : { unavailable_reason: quote.unavailable_reason }),
    ...(quote.unavailable_message === undefined
      ? {}
      : { unavailable_message: quote.unavailable_message }),
    ...(quote.pay_amount === undefined ? {} : { pay_amount: quote.pay_amount }),
    ...(quote.minimum_pay_amount === undefined
      ? {}
      : { minimum_pay_amount: quote.minimum_pay_amount }),
    ...(quote.maximum_pay_amount === undefined
      ? {}
      : { maximum_pay_amount: quote.maximum_pay_amount }),
    ...(quote.minimum_invoice_amount_msats === undefined
      ? {}
      : { minimum_invoice_amount_msats: quote.minimum_invoice_amount_msats }),
    ...(quote.maximum_invoice_amount_msats === undefined
      ? {}
      : { maximum_invoice_amount_msats: quote.maximum_invoice_amount_msats }),
  };
}

export async function selectSwapProvider(
  providers: readonly OpenReceiveSwapProvider[],
  payInAsset: OpenReceiveSwapPayInAsset,
): Promise<OpenReceiveSwapProvider | undefined> {
  for (const provider of providers) {
    if ((await provider.supportedPayInAssets()).has(payInAsset)) return provider;
  }
  return undefined;
}

export async function readReservedSwapAttemptForStartReplay(
  context: OpenReceiveServiceContext,
  record: StoredRecord,
  now: number,
): Promise<OpenReceiveInvoiceModel> {
  const state = readStoredSwapState(record.row);
  if (state !== "creating_provider_order") {
    return serializeInvoice(record.row, now);
  }

  if (now - record.row.created_at < OPENRECEIVE_SWAP_CREATING_TIMEOUT_SECONDS) {
    throw serviceError(
      409,
      "CONFLICT",
      "Swap payment address is still being prepared. Retry this swap start shortly.",
    );
  }

  // The reservation never received a provider order, so it has no deposit address to
  // return as a swap attempt. Retire it as failed (it is terminal, so a retry mints a
  // fresh attempt) and surface an actionable 409 instead of a deposit-less attempt.
  await updateSwapRecord(context, record, (swap) => ({
    ...swap,
    provider_state: "failed",
    attention: true,
    attention_reason: "provider_order_creation_stale",
    last_polled_at: now,
  }));
  throw serviceError(
    409,
    "CONFLICT",
    "The previous swap attempt failed before a deposit address was ready. Start the swap again.",
  );
}

export function roundMsatsUpToWholeSats(amountMsats: number): number {
  if (!Number.isSafeInteger(amountMsats) || amountMsats <= 0) {
    throw serviceError(400, "INVALID_REQUEST", "amount_msats must be a positive safe integer.");
  }
  const sats = Math.ceil(amountMsats / 1000);
  const rounded = sats * 1000;
  if (!Number.isSafeInteger(rounded)) {
    throw serviceError(400, "INVALID_REQUEST", "amount_msats is too large.");
  }
  return rounded;
}

export function swapInvoiceExpirySeconds(
  provider: OpenReceiveSwapProvider,
  payInAsset: OpenReceiveSwapPayInAsset,
): number {
  const expirySeconds =
    provider.invoiceExpirySeconds?.({ payInAsset }) ??
    getOpenReceiveSwapAssetInfo(payInAsset).expiry_seconds;
  if (!Number.isSafeInteger(expirySeconds) || expirySeconds <= 0) {
    throw serviceError(500, "INTERNAL", "Swap provider returned an invalid invoice expiry.");
  }
  return expirySeconds;
}

export function swapSettlementAttentionSeconds(context: OpenReceiveServiceContext): number {
  return (
    context.options.swap?.settlementAttentionSeconds ??
    OPENRECEIVE_SWAP_SETTLEMENT_ATTENTION_SECONDS
  );
}

export function findReusableSwapRecord(
  records: readonly StoredRecord[],
  payInAsset: OpenReceiveSwapPayInAsset,
  now: number,
): StoredRecord | undefined {
  return records
    .filter((record) => readStoredSwapPayInAsset(record.row) === payInAsset)
    .filter((record) => isReusableSwapRecord(record, now))
    .sort((left, right) => right.row.created_at - left.row.created_at)[0];
}

export function isReusableSwapRecord(record: StoredRecord, now: number): boolean {
  if (readInvoiceRail(record.row) !== "swap") return false;
  if (record.row.expires_at <= now) return false;
  if (record.row.transaction_state === "settled") return false;
  const state = readStoredSwapState(record.row);
  return state !== undefined && !isOpenReceiveSwapTerminalState(state);
}

export function shouldPollSwapRecord(record: StoredRecord, now: number): boolean {
  if (readInvoiceRail(record.row) !== "swap") return false;
  if (record.row.transaction_state === "settled") return false;
  const lastPolledAt = readStoredSwapLastPolledAt(record.row);
  const state = readStoredSwapState(record.row);
  return (
    state !== undefined &&
    state !== "creating_provider_order" &&
    !isOpenReceiveSwapTerminalState(state) &&
    storedSwapHasProviderOrder(record.row) &&
    (lastPolledAt === undefined || now - lastPolledAt >= 10)
  );
}

export async function updateSwapRecord(
  context: OpenReceiveServiceContext,
  record: StoredRecord,
  update: (swap: Record<string, unknown>) => Record<string, unknown>,
): Promise<StoredRecord> {
  return await updateSwapRecordWithPrivate(context, record, (swap, swapPrivate) => ({
    swap: update(swap),
    ...(swapPrivate === undefined ? {} : { swapPrivate }),
  }));
}

export async function updateSwapRecordWithPrivate(
  context: OpenReceiveServiceContext,
  record: StoredRecord,
  update: (
    swap: Record<string, unknown>,
    swapPrivate: Record<string, unknown> | undefined,
  ) => {
    readonly swap: Record<string, unknown>;
    readonly swapPrivate?: Record<string, unknown>;
  },
): Promise<StoredRecord> {
  let current = (await context.store.get(record.row.invoice_id)) ?? record;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const currentSwap = parseSwapMetadata(current.row);
    if (currentSwap === undefined) return current;
    const currentSwapPrivate = parseSwapPrivateMetadata(current.row);
    const next = update(currentSwap, currentSwapPrivate);
    const updated: StoredRecord = {
      rev: current.rev + 1,
      row: {
        ...current.row,
        metadata: {
          ...current.row.metadata,
          swap: next.swap,
          ...(next.swapPrivate === undefined ? {} : { swap_private: next.swapPrivate }),
        },
      },
    };
    const result = await context.store.put(updated, current.rev);
    if (result.status === "ok") return result.record;
    current = result.record;
  }
  return current;
}

export function parseSwapPayInAsset(value: unknown): OpenReceiveSwapPayInAsset {
  if (!isOpenReceiveSwapPayInAsset(value)) {
    throw serviceError(400, "INVALID_REQUEST", "pay_in_asset is not supported.");
  }
  return value;
}

export function parseSwapAttemptId(value: unknown): string {
  const attemptId = optionalString(value);
  if (attemptId === undefined) {
    throw serviceError(400, "INVALID_REQUEST", "attempt_id is required.");
  }
  if (attemptId.length > 200 || !attemptId.startsWith("or_inv_")) {
    throw serviceError(400, "INVALID_REQUEST", "attempt_id is not valid.");
  }
  return attemptId;
}

export function getStoredDescriptionFields(row: InvoiceStorageRow): {
  readonly description?: string;
  readonly description_hash?: string;
} {
  return getCreateDescriptionFields({
    memo: row.metadata.memo,
    descriptionHash: row.metadata.description_hash,
  });
}

export function assertRefundAddressShape(
  payInAsset: OpenReceiveSwapPayInAsset,
  refundAddress: string,
): void {
  if (!isValidSwapAddressForNetwork(payInAsset, refundAddress)) {
    throw serviceError(400, "INVALID_REQUEST", "refund_address is not valid for this asset.");
  }
}

export async function stageRefundAddress(
  context: OpenReceiveServiceContext,
  candidate: StoredRecord,
  input: {
    readonly attemptId: string;
    readonly payInAsset: OpenReceiveSwapPayInAsset;
    readonly refundAddress: string;
  },
): Promise<OpenReceiveInvoiceModel> {
  const now = context.clock();
  const currentSwap = parseSwapMetadata(candidate.row) ?? {};
  const submissionCount = optionalSafeInteger(currentSwap.refund_submission_count) ?? 0;
  if (submissionCount >= 5) {
    emitLog(
      context.options,
      "warn",
      "swap.refund.rate_limited",
      "Rate limited repeated refund address submissions for a swap attempt.",
      {
        invoice_id: input.attemptId,
        pay_in_asset: input.payInAsset,
        refund_submission_count: submissionCount,
      },
    );
    throw serviceError(429, "RATE_LIMITED", "Too many refund address submissions for this swap.");
  }

  const updated = await updateSwapRecord(context, candidate, (swap) => {
    if (optionalString(swap.provider_state) !== "refund_required") return swap;
    const nextSubmissionCount = (optionalSafeInteger(swap.refund_submission_count) ?? 0) + 1;
    return withSwapRefundFreshness(
      {
        ...swap,
        refund_address: input.refundAddress,
        refund_submission_count: nextSubmissionCount,
        refund_submitted_at: now,
        last_polled_at: now,
      },
      "refund_required",
      now,
    );
  });
  const updatedSubmissionCount =
    optionalSafeInteger(parseSwapMetadata(updated.row)?.refund_submission_count) ??
    submissionCount + 1;
  emitLog(
    context.options,
    updatedSubmissionCount > 1 ? "warn" : "info",
    "swap.refund.submitted",
    "Received refund address submission for confirmation.",
    {
      invoice_id: input.attemptId,
      pay_in_asset: input.payInAsset,
      refund_submission_count: updatedSubmissionCount,
    },
  );
  return serializeInvoice(updated.row, now);
}

export function assertRefundNonce(row: InvoiceStorageRow, refundNonce: string, now: number): void {
  const swap = parseSwapMetadata(row) ?? {};
  const expectedNonce = optionalString(swap.refund_nonce);
  const expiresAt = optionalSafeInteger(swap.refund_nonce_expires_at);
  if (expectedNonce === undefined || expiresAt === undefined || expiresAt <= now) {
    throw serviceError(
      409,
      "CONFLICT",
      "Refund confirmation expired. Refresh the swap status and submit the refund address again.",
    );
  }
  if (refundNonce !== expectedNonce) {
    throw serviceError(
      409,
      "CONFLICT",
      "Refund confirmation does not match the current swap state.",
    );
  }
}
