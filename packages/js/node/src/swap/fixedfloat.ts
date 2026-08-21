import { createHmac } from "node:crypto";
import { ceilDiv, OPENRECEIVE_SATS_PER_BTC, recordOrEmpty, unixSeconds } from "@openreceive/core";
import {
  getOpenReceiveSwapAssetInfo,
  isOpenReceiveLightningNetwork,
  isValidSwapAddressForNetwork,
  listOpenReceiveSwapAssetInfo,
  openReceiveSwapNetworkMatches,
  type SwapPayInAsset,
} from "./assets.ts";
import {
  compareFixedFloatDecimalAmounts,
  deserializeFixedFloatRatesIndex,
  type FixedFloatRatesIndex,
  fetchFixedFloatRatesIndex,
  fixedFloatRatesPairKey,
  fixedFloatRatesXmlPath,
  invoiceLimitsFromFixedFloatRate,
  quotePayAmountFromFixedFloatRate,
  retainFixedFloatRatePairsForKeys,
  serializeFixedFloatRatesIndex,
} from "./fixedfloat-rates.ts";
import {
  SWAP_LIMITS_MAX_STALE_SECONDS,
  swapLimitsMetaKey,
  type TransientSwapCache,
} from "./limits-cache.ts";
import type {
  SwapAttentionReason,
  SwapAvailabilityReason,
  SwapFee,
  SwapOrder,
  SwapProvider,
  SwapProviderApiRequestLog,
  SwapProviderApiResponseLog,
  SwapProviderAsset,
  SwapProviderState,
  SwapQuote,
  SwapRefundReason,
} from "./provider.ts";
import {
  SWAP_RATES_MAX_STALE_SECONDS,
  SWAP_RATES_REFRESH_SECONDS,
  swapRatesMetaKey,
} from "./rates-cache.ts";
import { isSwapProviderWeightBudgetError } from "./weight-budget.ts";

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

interface FixedFloatCurrency {
  readonly code: string;
  readonly coin: string;
  readonly network: string;
  readonly recv?: boolean;
  readonly send?: boolean;
}

interface FixedFloatCurrencyResolution {
  readonly fetched_at: number;
  readonly pay_in: ReadonlyMap<SwapPayInAsset, FixedFloatCurrency>;
  readonly lightning: FixedFloatCurrency;
}

interface FixedFloatEnvelope {
  readonly code?: unknown;
  readonly msg?: unknown;
  readonly data?: unknown;
}

class FixedFloatApiError extends Error {
  readonly path: string;
  readonly kind: "api" | "http" | "invalid_json" | "network" | "rate_limited" | "timeout";
  readonly status?: number;
  readonly fixedFloatCode?: unknown;
  readonly fixedFloatMessage?: string;

  constructor(input: {
    readonly path: string;
    readonly kind: FixedFloatApiError["kind"];
    readonly status?: number;
    readonly fixedFloatCode?: unknown;
    readonly fixedFloatMessage?: string;
    readonly message: string;
    readonly cause?: unknown;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "FixedFloatApiError";
    this.path = input.path;
    this.kind = input.kind;
    this.status = input.status;
    this.fixedFloatCode = input.fixedFloatCode;
    this.fixedFloatMessage = input.fixedFloatMessage;
  }

  static fromFetchError(path: string, error: unknown): FixedFloatApiError {
    const aborted =
      error instanceof Error &&
      (error.name === "AbortError" || error.message.toLowerCase().includes("abort"));
    return new FixedFloatApiError({
      path,
      kind: aborted ? "timeout" : "network",
      message: aborted
        ? `FixedFloat ${path} request timed out.`
        : `FixedFloat ${path} request failed before a response was received.`,
      cause: error,
    });
  }
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
  private readonly key: string;
  private readonly secret: string;
  private readonly baseUrl: string;
  private readonly lightningCcy: string | undefined;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly cacheSeconds: number;
  private readonly ratesCacheSeconds: number;
  private readonly requestTimeoutMs: number;
  private readonly invoiceExpirySecondsValue: number;
  private cache: TransientSwapCache | undefined;
  private apiRequestLogger: ((entry: SwapProviderApiRequestLog) => void) | undefined;
  private apiResponseLogger: ((entry: SwapProviderApiResponseLog) => void) | undefined;
  private weightBudget:
    | {
        reserve(path: string): Promise<void>;
        markRateLimited(): Promise<void>;
        canReserve(path: string): Promise<boolean>;
      }
    | undefined;

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

    this.key = options.key;
    this.secret = options.secret;
    this.baseUrl = (options.baseUrl ?? DEFAULT_FIXED_FLOAT_BASE_URL).replace(/\/+$/, "");
    const lightningCcy = options.lightningCcy?.trim();
    this.lightningCcy =
      lightningCcy === undefined || lightningCcy.length === 0 ? undefined : lightningCcy;
    this.fetcher = fetcher;
    this.now = options.now ?? unixSeconds;
    this.cacheSeconds = options.cacheSeconds ?? DEFAULT_CCIES_CACHE_SECONDS;
    this.ratesCacheSeconds = options.ratesCacheSeconds ?? DEFAULT_RATES_CACHE_SECONDS;
    if (!Number.isSafeInteger(this.ratesCacheSeconds) || this.ratesCacheSeconds <= 0) {
      throw new TypeError("FixedFloat ratesCacheSeconds must be a positive safe integer.");
    }
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_FIXED_FLOAT_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new TypeError("FixedFloat requestTimeoutMs must be a positive safe integer.");
    }
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
    this.apiRequestLogger = log;
  }

  attachApiResponseLogger(log: (entry: SwapProviderApiResponseLog) => void): void {
    this.apiResponseLogger = log;
  }

  attachWeightBudget(budget: {
    reserve(path: string): Promise<void>;
    markRateLimited(): Promise<void>;
    canReserve(path: string): Promise<boolean>;
  }): void {
    this.weightBudget = budget;
  }

  async canAcceptRequest(path: string): Promise<boolean> {
    if (this.weightBudget === undefined) return true;
    return await this.weightBudget.canReserve(path);
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
    const fromCcy = requiredCurrency(resolution, input.payInAsset);
    const rates = await this.resolveRatesIndex(resolution);
    try {
      const pair = rates.pairs[fixedFloatRatesPairKey(fromCcy, resolution.lightning.code)];
      if (pair === undefined) {
        return {
          pay_asset: input.payInAsset,
          available: false,
          unavailable_reason: "pair_temporarily_unavailable",
          unavailable_message: fixedFloatAvailabilityMessage("pair_temporarily_unavailable"),
          provider: this.name,
        };
      }
      const limits = invoiceLimitsFromFixedFloatRate(pair);
      const payAmount = quotePayAmountFromFixedFloatRate({
        pair,
        invoiceAmountMsats: input.invoiceAmountMsats,
      });
      if (payAmount === undefined) {
        return {
          pay_asset: input.payInAsset,
          available: false,
          unavailable_reason: "pair_temporarily_unavailable",
          unavailable_message: fixedFloatAvailabilityMessage("pair_temporarily_unavailable"),
          provider: this.name,
          ...limits,
        };
      }
      // Prefer invoice-side limits when conversion succeeded; also compare the
      // indicative pay amount to XML min/max so padded `<out>` decimals (or any
      // future conversion miss) cannot leave a below-min asset selectable.
      const payBelowMin =
        compareFixedFloatDecimalAmounts(payAmount, limits.minimum_pay_amount) === -1;
      const payAboveMax =
        compareFixedFloatDecimalAmounts(payAmount, limits.maximum_pay_amount) === 1;
      const amountTooSmall =
        payBelowMin ||
        (limits.minimum_invoice_amount_msats !== undefined &&
          input.invoiceAmountMsats < limits.minimum_invoice_amount_msats);
      const amountTooLarge =
        payAboveMax ||
        (limits.maximum_invoice_amount_msats !== undefined &&
          input.invoiceAmountMsats > limits.maximum_invoice_amount_msats);
      if (amountTooSmall || amountTooLarge) {
        const reason = amountTooSmall ? "amount_too_small" : "amount_too_large";
        return {
          pay_asset: input.payInAsset,
          available: false,
          unavailable_reason: reason,
          unavailable_message: fixedFloatAvailabilityMessage(reason),
          provider: this.name,
          ...limits,
        };
      }
      return {
        pay_amount: payAmount,
        pay_asset: input.payInAsset,
        available: true,
        provider: this.name,
        ...limits,
      };
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
    const fromCcy = requiredCurrency(resolution, input.payInAsset);
    const data = await this.post("create", {
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
      const data = await this.post("price", {
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
    const data = await this.post("order", {
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
    await this.post("emergency", {
      id: order.provider_order_id,
      token: order.provider_token,
      choice: "REFUND",
      address: refundAddress,
    });
  }

  private async post(path: string, body: Record<string, unknown>): Promise<unknown> {
    if (this.weightBudget !== undefined) {
      await this.weightBudget.reserve(path);
    }
    const bodyString = JSON.stringify(body);
    // Surface every outbound request before the call. The service sink sanitizes
    // nested secrets (e.g. the order token on status/refund bodies); the API key
    // and HMAC signature live in headers and are deliberately never logged.
    this.logApiRequest(path, body);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/api/v2/${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=UTF-8",
          "X-API-KEY": this.key,
          "X-API-SIGN": createHmac("sha256", this.secret).update(bodyString).digest("hex"),
        },
        body: bodyString,
        signal: controller.signal,
      });
    } catch (error) {
      const apiError = FixedFloatApiError.fromFetchError(path, error);
      this.logApiResponse({
        path,
        status: 0,
        ok: false,
        msg: apiError.message,
      });
      throw apiError;
    } finally {
      clearTimeout(timeout);
    }
    const text = await response.text();
    let parsed: FixedFloatEnvelope;
    try {
      parsed = text.length === 0 ? {} : (JSON.parse(text) as FixedFloatEnvelope);
    } catch (error) {
      this.logApiResponse({
        path,
        status: response.status,
        ok: false,
        msg: `FixedFloat ${path} returned invalid JSON.`,
      });
      throw new FixedFloatApiError({
        path,
        kind: "invalid_json",
        status: response.status,
        message: `FixedFloat ${path} returned invalid JSON.`,
        cause: error,
      });
    }
    // Surface every response (including API-error envelopes) before any throw. The
    // service sink sanitizes nested secrets — notably the order token in a
    // create/order response — so this must not pre-redact.
    this.logApiResponse({
      path,
      status: response.status,
      ok: response.ok,
      code: parsed.code,
      msg: parsed.msg,
      data: parsed.data,
    });
    if (!response.ok) {
      if (response.status === 429 && this.weightBudget !== undefined) {
        await this.weightBudget.markRateLimited();
      }
      throw new FixedFloatApiError({
        path,
        kind: response.status === 429 ? "rate_limited" : "http",
        status: response.status,
        fixedFloatMessage: optionalCoercedString(parsed.msg),
        message: formatFixedFloatApiErrorMessage(path, response.status, parsed.msg),
      });
    }
    if (parsed.code !== 0) {
      throw new FixedFloatApiError({
        path,
        kind: "api",
        fixedFloatCode: parsed.code,
        fixedFloatMessage: optionalCoercedString(parsed.msg),
        message: typeof parsed.msg === "string" ? parsed.msg : `FixedFloat ${path} failed.`,
      });
    }
    return parsed.data;
  }

  private logApiRequest(path: string, body: Record<string, unknown> = {}): void {
    this.apiRequestLogger?.({
      provider: this.name,
      path,
      body,
    });
  }

  private logApiResponse(input: {
    readonly path: string;
    readonly status: number;
    readonly ok: boolean;
    readonly code?: unknown;
    readonly msg?: unknown;
    readonly data?: unknown;
  }): void {
    this.apiResponseLogger?.({
      provider: this.name,
      path: input.path,
      status: input.status,
      ok: input.ok,
      code: input.code,
      msg: input.msg,
      data: input.data,
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
      serialize: serializeCurrencyResolution,
      deserialize: deserializeCurrencyResolution,
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
    this.logApiRequest(path);
    try {
      const fetched = await fetchFixedFloatRatesIndex({
        baseUrl: this.baseUrl,
        rateType: "fixed",
        fetch: this.fetcher,
        now: this.now,
        requestTimeoutMs: this.requestTimeoutMs,
      });
      const index = retainFixedFloatRatePairsForKeys(
        fetched,
        openReceiveFixedFloatRatePairKeys(resolution),
      );
      this.logApiResponse({
        path,
        status: 200,
        ok: true,
        data: { pair_count: Object.keys(index.pairs).length },
      });
      return index;
    } catch (error) {
      this.logApiResponse({
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
    const data = await this.post("ccies", {});
    const currencies = readFixedFloatCurrencies(data);
    const payIn = new Map<SwapPayInAsset, FixedFloatCurrency>();
    for (const asset of listOpenReceiveSwapAssetInfo()) {
      const found = currencies.find(
        (currency) =>
          currency.coin.toUpperCase() === asset.coin &&
          openReceiveSwapNetworkMatches(asset.network, currency.network) &&
          // /ccies recv=false means FixedFloat will not accept deposits for this
          // currency — omit it from the catalog rather than failing at /create.
          currency.recv !== false,
      );
      if (found !== undefined) payIn.set(asset.pay_in_asset, found);
    }

    const lightningCurrency =
      this.lightningCcy === undefined
        ? currencies.find(
            (currency) =>
              currency.coin.toUpperCase() === "BTC" &&
              isOpenReceiveLightningNetwork(currency.network) &&
              // Payout side must be sendable to the merchant's bolt11.
              currency.send !== false,
          )
        : currencies.find(
            (currency) => currency.code === this.lightningCcy && currency.send !== false,
          );
    if (lightningCurrency === undefined) {
      throw new Error("FixedFloat /ccies did not include a BTC Lightning payout currency.");
    }

    return {
      fetched_at: now,
      pay_in: payIn,
      lightning: lightningCurrency,
    };
  }
}

function serializeCurrencyResolution(resolution: FixedFloatCurrencyResolution): string {
  return JSON.stringify({
    fetched_at: resolution.fetched_at,
    pay_in: Array.from(resolution.pay_in.entries()),
    lightning: resolution.lightning,
  });
}

function deserializeCurrencyResolution(value: string): FixedFloatCurrencyResolution {
  const parsed = JSON.parse(value) as {
    readonly fetched_at: number;
    readonly pay_in: readonly (readonly [SwapPayInAsset, FixedFloatCurrency])[];
    readonly lightning: FixedFloatCurrency;
  };
  return {
    fetched_at: parsed.fetched_at,
    pay_in: new Map(parsed.pay_in),
    lightning: parsed.lightning,
  };
}

function openReceiveFixedFloatRatePairKeys(resolution: FixedFloatCurrencyResolution): Set<string> {
  const keys = new Set<string>();
  for (const currency of resolution.pay_in.values()) {
    keys.add(fixedFloatRatesPairKey(currency.code, resolution.lightning.code));
  }
  return keys;
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

function requiredCurrency(
  resolution: FixedFloatCurrencyResolution,
  payInAsset: SwapPayInAsset,
): string {
  const currency = resolution.pay_in.get(payInAsset);
  if (currency === undefined) {
    const label = getOpenReceiveSwapAssetInfo(payInAsset).pay_in_asset;
    throw new Error(`FixedFloat does not currently support ${label}.`);
  }
  return currency.code;
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

type QuoteErrorPattern = readonly [RegExp, SwapAvailabilityReason];

/**
 * Stringly-typed fallbacks for a quote failure that carries no machine-readable
 * code: FixedFloat reports "amount too small" in prose only. First match wins, so
 * the order is the priority order, and both callers below share one table so the
 * amount rules cannot drift apart again.
 */
const AMOUNT_QUOTE_ERROR_PATTERNS: readonly QuoteErrorPattern[] = [
  [/min|small|out of limits|limit_min/, "amount_too_small"],
  [/max|large|limit_max/, "amount_too_large"],
];

/** A non-API error exposes no status or kind, so transport is read from the message too. */
const ANY_QUOTE_ERROR_PATTERNS: readonly QuoteErrorPattern[] = [
  [/rate|429|weight budget/, "provider_rate_limited"],
  [/fetch|network|timeout/, "provider_unreachable"],
  ...AMOUNT_QUOTE_ERROR_PATTERNS,
];

function classifyQuoteErrorMessage(
  message: string,
  patterns: readonly QuoteErrorPattern[],
): SwapAvailabilityReason {
  for (const [pattern, reason] of patterns) {
    if (pattern.test(message)) return reason;
  }
  return "pair_temporarily_unavailable";
}

function classifyFixedFloatQuoteError(error: unknown): SwapAvailabilityReason {
  if (isSwapProviderWeightBudgetError(error)) return "provider_rate_limited";
  if (error instanceof FixedFloatApiError) {
    if (error.kind === "rate_limited" || error.status === 429) return "provider_rate_limited";
    if (
      error.kind === "timeout" ||
      error.kind === "network" ||
      error.kind === "invalid_json" ||
      (error.status !== undefined && error.status >= 500)
    ) {
      return "provider_unreachable";
    }
    // The API answered, so transport is known good: only the amount rules apply.
    return classifyQuoteErrorMessage(
      error.fixedFloatMessage?.toLowerCase() ?? error.message.toLowerCase(),
      AMOUNT_QUOTE_ERROR_PATTERNS,
    );
  }
  return classifyQuoteErrorMessage(
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase(),
    ANY_QUOTE_ERROR_PATTERNS,
  );
}

function fixedFloatAvailabilityMessage(reason: SwapAvailabilityReason): string {
  if (reason === "amount_too_small") return "This invoice is below the provider minimum.";
  if (reason === "amount_too_large") return "This invoice is above the provider maximum.";
  if (reason === "provider_rate_limited") return "The swap provider is rate limited.";
  if (reason === "provider_unreachable") return "The swap provider is temporarily unreachable.";
  return "This payment route is temporarily unavailable.";
}

function formatFixedFloatApiErrorMessage(path: string, status: number, msg: unknown): string {
  const fixedFloatMessage = optionalCoercedString(msg);
  return fixedFloatMessage === undefined
    ? `FixedFloat ${path} failed with HTTP ${status}.`
    : `FixedFloat ${path} failed with HTTP ${status}: ${fixedFloatMessage}`;
}

interface FixedFloatOrderInput {
  readonly provider: string;
  readonly payInAsset: SwapPayInAsset;
  /** The order we already persisted, when this is a poll rather than a create. */
  readonly fallback?: SwapOrder;
  readonly now?: () => number;
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

/**
 * Shape the resolved fields into the SwapOrder we both persist as swap_data and
 * hand back to the payer (via publicSwap). Nothing here reads the raw body.
 */
function normalizeFixedFloatOrder(data: unknown, input: FixedFloatOrderInput): SwapOrder {
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
function readFixedFloatOrderFee(record: Record<string, unknown>): SwapFee | undefined {
  const payInFiat = optionalNestedString(record, ["from", "usd"]);
  const payoutFiat = optionalNestedString(record, ["to", "usd"]);
  if (payInFiat === undefined || payoutFiat === undefined) return undefined;
  return { currency: "USD", pay_in_fiat: payInFiat, payout_fiat: payoutFiat };
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

function readDecimalAmountString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return /^[0-9]+(\.[0-9]+)?$/.test(value) ? value : undefined;
}

function readFixedFloatCurrencies(data: unknown): FixedFloatCurrency[] {
  const record = recordOrEmpty(data);
  const items = Array.isArray(data)
    ? data
    : Array.isArray(record.ccies)
      ? record.ccies
      : Array.isArray(record.currencies)
        ? record.currencies
        : [];
  const currencies: FixedFloatCurrency[] = [];
  for (const item of items) {
    const record = recordOrEmpty(item);
    const code = optionalStringField(record, "code") ?? optionalStringField(record, "ticker");
    const coin =
      optionalStringField(record, "coin") ??
      optionalStringField(record, "currency") ??
      optionalStringField(record, "symbol");
    const network =
      optionalStringField(record, "network") ??
      optionalStringField(record, "chain") ??
      optionalStringField(record, "networkName") ??
      optionalStringField(record, "name");
    if (code !== undefined && coin !== undefined && network !== undefined) {
      currencies.push({
        code,
        coin: coin.toUpperCase(),
        network,
        ...(typeof record.recv === "boolean" ? { recv: record.recv } : {}),
        ...(typeof record.send === "boolean" ? { send: record.send } : {}),
      });
    }
  }
  return currencies;
}

function readEmergencyRepeat(emergency: Record<string, unknown> | undefined): boolean | undefined {
  if (emergency === undefined) return undefined;
  const value = emergency.repeat;
  if (typeof value === "boolean") return value;
  if (value === 0 || value === "0") return false;
  if (value === 1 || value === "1") return true;
  return undefined;
}

function optionalNestedString(value: unknown, path: readonly string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    current = recordOrEmpty(current)[key];
  }
  return optionalCoercedString(current);
}

function optionalStringField(
  record: Record<string, unknown> | undefined,
  field: string,
): string | undefined {
  if (record === undefined) return undefined;
  return optionalCoercedString(record[field]);
}

function optionalStringArrayField(
  record: Record<string, unknown> | undefined,
  field: string,
): readonly string[] {
  if (record === undefined) return [];
  const value = record[field];
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const string = optionalCoercedString(item);
      return string === undefined ? [] : [string];
    });
  }
  const string = optionalCoercedString(value);
  return string === undefined ? [] : [string];
}

function optionalCoercedString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function requiredString(value: unknown, field: string): string {
  const string = optionalCoercedString(value);
  if (string === undefined) {
    throw new Error(`FixedFloat response missing ${field}.`);
  }
  return string;
}

function readUnixSeconds(value: unknown): number | undefined {
  const numeric = typeof value === "string" ? Number(value) : value;
  return typeof numeric === "number" && Number.isSafeInteger(numeric) && numeric >= 0
    ? numeric
    : undefined;
}
