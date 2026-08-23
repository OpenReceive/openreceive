/**
 * The FixedFloat-compatible SwapProvider: option defaults and validation, the
 * provider id, and the assembly that routes every SwapProvider call through the
 * signed transport, the `/ccies` resolution and XML rates index held in the
 * transient cache, and the order / quote normalizers beside this file.
 */

import { ceilDiv, OPENRECEIVE_SATS_PER_BTC, recordOrEmpty, unixSeconds } from "@openreceive/core";
import type { SwapPayInAsset } from "./assets.ts";
import {
  deserializeFixedFloatCurrencyResolution,
  type FixedFloatCurrencyResolution,
  fixedFloatRatePairKeys,
  requiredFixedFloatCurrency,
  resolveFixedFloatCurrencies,
  serializeFixedFloatCurrencyResolution,
} from "./fixedfloat-currencies.ts";
import { normalizeFixedFloatOrder, readFixedFloatOrderFee } from "./fixedfloat-orders.ts";
import {
  classifyFixedFloatQuoteError,
  fixedFloatAvailabilityMessage,
  fixedFloatQuoteFromRatePair,
} from "./fixedfloat-quote.ts";
import {
  deserializeFixedFloatRatesIndex,
  type FixedFloatRatesIndex,
  fetchFixedFloatRatesIndex,
  fixedFloatRatesPairKey,
  fixedFloatRatesXmlPath,
  invoiceLimitsFromFixedFloatRate,
  retainFixedFloatRatePairsForKeys,
  serializeFixedFloatRatesIndex,
} from "./fixedfloat-rates.ts";
import { FixedFloatTransport, type FixedFloatWeightBudget } from "./fixedfloat-transport.ts";
import {
  SWAP_LIMITS_MAX_STALE_SECONDS,
  swapLimitsMetaKey,
  type TransientSwapCache,
} from "./limits-cache.ts";
import type {
  SwapFee,
  SwapOrder,
  SwapProvider,
  SwapProviderApiRequestLog,
  SwapProviderApiResponseLog,
  SwapProviderAsset,
  SwapQuote,
} from "./provider.ts";
import {
  SWAP_RATES_MAX_STALE_SECONDS,
  SWAP_RATES_REFRESH_SECONDS,
  swapRatesMetaKey,
} from "./rates-cache.ts";

export interface FixedFloatProviderOptions {
  readonly key: string;
  readonly secret: string;
  readonly baseUrl?: string;
  readonly lightningCcy?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  /** TTL for the disposable `/ccies` currency catalog cache. */
  readonly cacheSeconds?: number;
  /**
   * TTL for the process-local public XML rates cache (`/rates/fixed.xml`). Defaults to
   * {@link SWAP_RATES_REFRESH_SECONDS}. Shared only within the current process.
   */
  readonly ratesCacheSeconds?: number;
  readonly requestTimeoutMs?: number;
  readonly invoiceExpirySeconds?: number;
  readonly depositWindowSeconds?: number;
  readonly settlementSlaSeconds?: number;
  readonly invoiceExpiryMarginSeconds?: number;
}

export interface FixedFloatCompatibleSwapProviderOptions extends FixedFloatProviderOptions {
  readonly id: string;
}

const DEFAULT_FIXED_FLOAT_BASE_URL = "https://ff.io";
const DEFAULT_CCIES_CACHE_SECONDS = 24 * 60 * 60;
const DEFAULT_RATES_CACHE_SECONDS = SWAP_RATES_REFRESH_SECONDS;
const DEFAULT_FIXED_FLOAT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_FIXED_FLOAT_DEPOSIT_WINDOW_SECONDS = 10 * 60;
const DEFAULT_FIXED_FLOAT_SETTLEMENT_SLA_SECONDS = 15 * 60;
/**
 * Margin above deposit_window + settlement_sla. Five minutes keeps the shadow
 * invoice alive through a plausible 30-minute provider order.
 */
const DEFAULT_FIXED_FLOAT_INVOICE_EXPIRY_MARGIN_SECONDS = 5 * 60;

export function fixedFloatProvider(options: FixedFloatProviderOptions): SwapProvider {
  return fixedFloatCompatibleSwapProvider({
    ...options,
    id: "fixedfloat",
  });
}

export function fixedFloatCompatibleSwapProvider(
  options: FixedFloatCompatibleSwapProviderOptions,
): SwapProvider {
  return new FixedFloatProvider(options);
}

class FixedFloatProvider implements SwapProvider {
  readonly name: string;
  private readonly lightningCcy: string | undefined;
  private readonly now: () => number;
  private readonly cacheSeconds: number;
  private readonly ratesCacheSeconds: number;
  private readonly invoiceExpirySecondsValue: number;
  private readonly transport: FixedFloatTransport;
  private cache: TransientSwapCache | undefined;

  constructor(options: FixedFloatCompatibleSwapProviderOptions) {
    this.name = readFixedFloatCompatibleProviderId(options.id);
    if (options.key.trim().length === 0) {
      throw new TypeError("FixedFloat-compatible API key must not be empty.");
    }
    if (options.secret.trim().length === 0) {
      throw new TypeError("FixedFloat-compatible API secret must not be empty.");
    }
    const fetcher = options.fetch ?? globalThis.fetch;
    if (fetcher === undefined) {
      throw new TypeError("FixedFloat-compatible provider requires fetch.");
    }

    const lightningCcy = options.lightningCcy?.trim();
    this.lightningCcy =
      lightningCcy === undefined || lightningCcy.length === 0 ? undefined : lightningCcy;
    this.now = options.now ?? unixSeconds;
    this.cacheSeconds = options.cacheSeconds ?? DEFAULT_CCIES_CACHE_SECONDS;
    this.ratesCacheSeconds = options.ratesCacheSeconds ?? DEFAULT_RATES_CACHE_SECONDS;
    if (!Number.isSafeInteger(this.ratesCacheSeconds) || this.ratesCacheSeconds <= 0) {
      throw new TypeError("FixedFloat ratesCacheSeconds must be a positive safe integer.");
    }
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_FIXED_FLOAT_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new TypeError("FixedFloat requestTimeoutMs must be a positive safe integer.");
    }
    this.transport = new FixedFloatTransport({
      provider: this.name,
      key: options.key,
      secret: options.secret,
      baseUrl: (options.baseUrl ?? DEFAULT_FIXED_FLOAT_BASE_URL).replace(/\/+$/, ""),
      fetch: fetcher,
      requestTimeoutMs,
    });
    const depositWindowSeconds =
      options.depositWindowSeconds ?? DEFAULT_FIXED_FLOAT_DEPOSIT_WINDOW_SECONDS;
    const settlementSlaSeconds =
      options.settlementSlaSeconds ?? DEFAULT_FIXED_FLOAT_SETTLEMENT_SLA_SECONDS;
    const invoiceExpiryMarginSeconds =
      options.invoiceExpiryMarginSeconds ?? DEFAULT_FIXED_FLOAT_INVOICE_EXPIRY_MARGIN_SECONDS;
    for (const [name, value] of [
      ["FixedFloat depositWindowSeconds", depositWindowSeconds],
      ["FixedFloat settlementSlaSeconds", settlementSlaSeconds],
      ["FixedFloat invoiceExpiryMarginSeconds", invoiceExpiryMarginSeconds],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${name} must be a non-negative safe integer.`);
      }
    }
    const minimumInvoiceExpirySeconds =
      depositWindowSeconds + settlementSlaSeconds + invoiceExpiryMarginSeconds;
    this.invoiceExpirySecondsValue = options.invoiceExpirySeconds ?? minimumInvoiceExpirySeconds;
    if (
      !Number.isSafeInteger(this.invoiceExpirySecondsValue) ||
      this.invoiceExpirySecondsValue < minimumInvoiceExpirySeconds
    ) {
      throw new TypeError(
        `FixedFloat provider ${JSON.stringify(this.name)}: invoice_expiry_seconds ` +
          `(${this.invoiceExpirySecondsValue}) must be at least ${minimumInvoiceExpirySeconds} = ` +
          `deposit_window(${depositWindowSeconds}) + settlement_sla(${settlementSlaSeconds}) + ` +
          `margin(${invoiceExpiryMarginSeconds}). Omit invoice_expiry_seconds to auto-derive it, ` +
          `or raise it above that floor.`,
      );
    }
  }

  attachSwapCache(cache: TransientSwapCache): void {
    this.cache = cache;
  }

  attachApiRequestLogger(log: (entry: SwapProviderApiRequestLog) => void): void {
    this.transport.attachApiRequestLogger(log);
  }

  attachApiResponseLogger(log: (entry: SwapProviderApiResponseLog) => void): void {
    this.transport.attachApiResponseLogger(log);
  }

  attachWeightBudget(budget: FixedFloatWeightBudget): void {
    this.transport.attachWeightBudget(budget);
  }

  async canAcceptRequest(path: string): Promise<boolean> {
    return await this.transport.canAcceptRequest(path);
  }

  async supportedPayInAssets(): Promise<Set<SwapPayInAsset>> {
    const resolution = await this.resolveCurrencies();
    return new Set(resolution.pay_in.keys());
  }

  async payInAssetCatalog(): Promise<readonly SwapProviderAsset[]> {
    const resolution = await this.resolveCurrencies();
    // /ccies reports only availability and display metadata per currency — it carries
    // no amount limits. Per-pair min/max come from the public XML rates export, cached
    // in this process so the payment-method screen never hits /price. Only the small
    // OpenReceive pay-in → Lightning set is retained from the provider dump.
    const rates = await this.resolveRatesIndex(resolution);
    return Array.from(resolution.pay_in.entries(), ([payInAsset, currency]) => {
      const pair = rates.pairs[fixedFloatRatesPairKey(currency.code, resolution.lightning.code)];
      if (pair === undefined) {
        return {
          pay_asset: payInAsset,
          available: false,
          unavailable_reason: "pair_temporarily_unavailable" as const,
          unavailable_message: fixedFloatAvailabilityMessage("pair_temporarily_unavailable"),
        };
      }
      return {
        pay_asset: payInAsset,
        ...invoiceLimitsFromFixedFloatRate(pair),
      };
    });
  }

  invoiceExpirySeconds(): number {
    return this.invoiceExpirySecondsValue;
  }

  async quote(input: {
    readonly payInAsset: SwapPayInAsset;
    readonly invoiceAmountMsats: number;
  }): Promise<SwapQuote> {
    // Indicative quote from the process-local XML rates cache. `/create` is still the
    // binding rate — this keeps concurrent checkouts from each burning a /price weight
    // unit (same pattern as the fiat price feed / NWC settlement sweep gate).
    // Rates refresh failures throw (fail closed) so the service can skip this provider
    // and try the next configured LSC connection.
    const resolution = await this.resolveCurrencies();
    const fromCcy = requiredFixedFloatCurrency(resolution, input.payInAsset);
    const rates = await this.resolveRatesIndex(resolution);
    try {
      return fixedFloatQuoteFromRatePair({
        pair: rates.pairs[fixedFloatRatesPairKey(fromCcy, resolution.lightning.code)],
        payInAsset: input.payInAsset,
        invoiceAmountMsats: input.invoiceAmountMsats,
        provider: this.name,
      });
    } catch (error) {
      // Pair-math / limit errors stay as unavailable quotes. Rates/network failures
      // already threw above from resolveRatesIndex and must not be swallowed here.
      const reason = classifyFixedFloatQuoteError(error);
      return {
        pay_asset: input.payInAsset,
        available: false,
        unavailable_reason: reason,
        unavailable_message: fixedFloatAvailabilityMessage(reason),
        provider: this.name,
      };
    }
  }

  async createSwap(input: {
    readonly payInAsset: SwapPayInAsset;
    readonly bolt11: string;
    readonly invoiceAmountMsats: number;
  }): Promise<SwapOrder> {
    const resolution = await this.resolveCurrencies();
    const fromCcy = requiredFixedFloatCurrency(resolution, input.payInAsset);
    const data = await this.transport.post("create", {
      type: "fixed",
      fromCcy,
      toCcy: resolution.lightning.code,
      direction: "to",
      amount: amountMsatsToBtcString(input.invoiceAmountMsats),
      toAddress: input.bolt11,
    });
    const order = normalizeFixedFloatOrder(data, {
      now: this.now,
      provider: this.name,
      payInAsset: input.payInAsset,
    });
    // FixedFloat order objects do not always carry the USD equivalents (`from.usd` /
    // `to.usd`) that explain the swap fee, so backfill them from a best-effort /price
    // lookup for the same trade. A failure just leaves the fee off the deposit panel.
    if (order.fee !== undefined) return order;
    const fee = await this.fetchFixedFloatOrderFee(
      fromCcy,
      resolution.lightning.code,
      input.invoiceAmountMsats,
    );
    return fee === undefined ? order : { ...order, fee };
  }

  private async fetchFixedFloatOrderFee(
    fromCcy: string,
    toCcy: string,
    invoiceAmountMsats: number,
  ): Promise<SwapFee | undefined> {
    try {
      const data = await this.transport.post("price", {
        type: "fixed",
        fromCcy,
        toCcy,
        direction: "to",
        amount: amountMsatsToBtcString(invoiceAmountMsats),
      });
      return readFixedFloatOrderFee(recordOrEmpty(data));
    } catch {
      return undefined;
    }
  }

  async getStatus(order: SwapOrder): Promise<SwapOrder> {
    const data = await this.transport.post("order", {
      id: order.provider_order_id,
      token: order.provider_token,
    });
    return {
      ...order,
      ...normalizeFixedFloatOrder(data, {
        now: this.now,
        provider: this.name,
        payInAsset: order.pay_in_asset,
        fallback: order,
      }),
    };
  }

  async requestRefund(order: SwapOrder, refundAddress: string): Promise<void> {
    await this.transport.post("emergency", {
      id: order.provider_order_id,
      token: order.provider_token,
      choice: "REFUND",
      address: refundAddress,
    });
  }

  private async resolveCurrencies(): Promise<FixedFloatCurrencyResolution> {
    const cache = this.cache;
    if (cache === undefined) {
      // No transient cache attached (e.g. tests / standalone use): fetch fresh
      // each call. The resolution is never retained in process memory.
      return await this.fetchCurrencyResolution();
    }
    return await cache.resolve(swapLimitsMetaKey(this.name), {
      refreshSeconds: this.cacheSeconds,
      maxStaleSeconds: Math.max(SWAP_LIMITS_MAX_STALE_SECONDS, this.cacheSeconds),
      fetch: () => this.fetchCurrencyResolution(),
      serialize: serializeFixedFloatCurrencyResolution,
      deserialize: deserializeFixedFloatCurrencyResolution,
    });
  }

  private async resolveRatesIndex(
    resolution: FixedFloatCurrencyResolution,
  ): Promise<FixedFloatRatesIndex> {
    const cache = this.cache;
    if (cache === undefined) {
      return await this.fetchRatesIndex(resolution);
    }
    return await cache.resolve(swapRatesMetaKey(this.name, "fixed"), {
      refreshSeconds: this.ratesCacheSeconds,
      maxStaleSeconds: Math.max(SWAP_RATES_MAX_STALE_SECONDS, this.ratesCacheSeconds),
      // Crypto rates must not linger after a failed refresh — fail closed so the
      // service can skip this provider and try the next configured LSC connection.
      serveStaleOnFailure: false,
      fetch: () => this.fetchRatesIndex(resolution),
      serialize: serializeFixedFloatRatesIndex,
      deserialize: deserializeFixedFloatRatesIndex,
    });
  }

  private async fetchRatesIndex(
    resolution: FixedFloatCurrencyResolution,
  ): Promise<FixedFloatRatesIndex> {
    const path = fixedFloatRatesXmlPath("fixed").replace(/^\//, "");
    this.transport.logApiRequest(path);
    try {
      const fetched = await fetchFixedFloatRatesIndex({
        baseUrl: this.transport.baseUrl,
        rateType: "fixed",
        fetch: this.transport.fetcher,
        now: this.now,
        requestTimeoutMs: this.transport.requestTimeoutMs,
      });
      const index = retainFixedFloatRatePairsForKeys(fetched, fixedFloatRatePairKeys(resolution));
      this.transport.logApiResponse({
        path,
        status: 200,
        ok: true,
        data: { pair_count: Object.keys(index.pairs).length },
      });
      return index;
    } catch (error) {
      this.transport.logApiResponse({
        path,
        status: 0,
        ok: false,
        msg: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async fetchCurrencyResolution(): Promise<FixedFloatCurrencyResolution> {
    const now = this.now();
    const data = await this.transport.post("ccies", {});
    return resolveFixedFloatCurrencies(data, { fetchedAt: now, lightningCcy: this.lightningCcy });
  }
}

function readFixedFloatCompatibleProviderId(id: string): string {
  const normalized = id.trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw new TypeError(
      "FixedFloat-compatible provider id must use lowercase letters, numbers, underscores, or hyphens.",
    );
  }
  return normalized;
}

function amountMsatsToBtcString(amountMsats: number): string {
  if (!Number.isSafeInteger(amountMsats) || amountMsats <= 0) {
    throw new RangeError("invoiceAmountMsats must be a positive safe integer.");
  }
  const sats = ceilDiv(BigInt(amountMsats), 1000n);
  const wholeBtc = sats / OPENRECEIVE_SATS_PER_BTC;
  const fractional = String(sats % OPENRECEIVE_SATS_PER_BTC)
    .padStart(8, "0")
    .replace(/0+$/, "");
  return fractional.length === 0 ? String(wholeBtc) : `${wholeBtc}.${fractional}`;
}
