import { createHmac } from "node:crypto";
import {
  getOpenReceiveSwapAssetInfo,
  isOpenReceiveLightningNetwork,
  isValidSwapAddressForNetwork,
  listOpenReceiveSwapAssetInfo,
  type SwapPayInAsset,
  openReceiveSwapNetworkMatches,
} from "./assets.ts";
import {
  deserializeFixedFloatRatesIndex,
  fetchFixedFloatRatesIndex,
  fixedFloatRatesPairKey,
  compareFixedFloatDecimalAmounts,
  invoiceLimitsFromFixedFloatRate,
  quotePayAmountFromFixedFloatRate,
  serializeFixedFloatRatesIndex,
  type FixedFloatRatesIndex,
} from "./fixedfloat-rates.ts";
import {
  type TransientSwapCache,
  SWAP_LIMITS_MAX_STALE_SECONDS,
  swapLimitsMetaKey,
} from "./limits-cache.ts";
import type {
  SwapAttentionReason,
  SwapAvailabilityReason,
  SwapFee,
  SwapOrder,
  SwapProvider,
  SwapProviderAsset,
  SwapProviderState,
  SwapQuote,
  SwapProviderApiRequestLog,
  SwapProviderApiResponseLog,
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
 * Margin above deposit_window + settlement_sla. FixedFloat order examples show
 * ~1800s deposit windows; the previous 120s margin left shadow invoices at 1620s
 * — shorter than a plausible FF order. 300s yields a 1800s default floor.
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
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
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
    // in this process so the payment-method screen never hits /price.
    const rates = await this.resolveRatesIndex();
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
    const rates = await this.resolveRatesIndex();
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
    assertFixedFloatPayoutAmountMatchesInvoice(data, input.invoiceAmountMsats);

    const order = normalizeFixedFloatOrder(data, {
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
      return readFixedFloatOrderFee(asRecord(data));
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
    this.apiRequestLogger?.({
      provider: this.name,
      path,
      body,
    });
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
      throw FixedFloatApiError.fromFetchError(path, error);
    } finally {
      clearTimeout(timeout);
    }
    const text = await response.text();
    let parsed: FixedFloatEnvelope;
    try {
      parsed = text.length === 0 ? {} : (JSON.parse(text) as FixedFloatEnvelope);
    } catch (error) {
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
    this.apiResponseLogger?.({
      provider: this.name,
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
        fixedFloatMessage: readString(parsed.msg),
        message: formatFixedFloatApiErrorMessage(path, response.status, parsed.msg),
      });
    }
    if (parsed.code !== 0) {
      throw new FixedFloatApiError({
        path,
        kind: "api",
        fixedFloatCode: parsed.code,
        fixedFloatMessage: readString(parsed.msg),
        message: typeof parsed.msg === "string" ? parsed.msg : `FixedFloat ${path} failed.`,
      });
    }
    return parsed.data;
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

  private async resolveRatesIndex(): Promise<FixedFloatRatesIndex> {
    const cache = this.cache;
    if (cache === undefined) {
      return await this.fetchRatesIndex();
    }
    return await cache.resolve(swapRatesMetaKey(this.name, "fixed"), {
      refreshSeconds: this.ratesCacheSeconds,
      maxStaleSeconds: Math.max(SWAP_RATES_MAX_STALE_SECONDS, this.ratesCacheSeconds),
      // Crypto rates must not linger after a failed refresh — fail closed so the
      // service can skip this provider and try the next configured LSC connection.
      serveStaleOnFailure: false,
      fetch: () => this.fetchRatesIndex(),
      serialize: serializeFixedFloatRatesIndex,
      deserialize: deserializeFixedFloatRatesIndex,
    });
  }

  private async fetchRatesIndex(): Promise<FixedFloatRatesIndex> {
    return await fetchFixedFloatRatesIndex({
      baseUrl: this.baseUrl,
      rateType: "fixed",
      fetch: this.fetcher,
      now: this.now,
      requestTimeoutMs: this.requestTimeoutMs,
    });
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
  const sats = Math.ceil(amountMsats / 1000);
  const wholeBtc = Math.floor(sats / 100_000_000);
  const fractional = String(sats % 100_000_000)
    .padStart(8, "0")
    .replace(/0+$/, "");
  return fractional.length === 0 ? String(wholeBtc) : `${wholeBtc}.${fractional}`;
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
    const message = error.fixedFloatMessage?.toLowerCase() ?? error.message.toLowerCase();
    if (
      message.includes("min") ||
      message.includes("small") ||
      message.includes("out of limits") ||
      message.includes("limit_min")
    ) {
      return "amount_too_small";
    }
    if (message.includes("max") || message.includes("large") || message.includes("limit_max")) {
      return "amount_too_large";
    }
    return "pair_temporarily_unavailable";
  }
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("rate") || message.includes("429") || message.includes("weight budget")) {
    return "provider_rate_limited";
  }
  if (message.includes("fetch") || message.includes("network") || message.includes("timeout")) {
    return "provider_unreachable";
  }
  if (
    message.includes("min") ||
    message.includes("small") ||
    message.includes("out of limits") ||
    message.includes("limit_min")
  ) {
    return "amount_too_small";
  }
  if (message.includes("max") || message.includes("large") || message.includes("limit_max")) {
    return "amount_too_large";
  }
  return "pair_temporarily_unavailable";
}

function fixedFloatAvailabilityMessage(reason: SwapAvailabilityReason): string {
  if (reason === "amount_too_small") return "This invoice is below the provider minimum.";
  if (reason === "amount_too_large") return "This invoice is above the provider maximum.";
  if (reason === "provider_rate_limited") return "The swap provider is rate limited.";
  if (reason === "provider_unreachable") return "The swap provider is temporarily unreachable.";
  return "This payment route is temporarily unavailable.";
}

function formatFixedFloatApiErrorMessage(path: string, status: number, msg: unknown): string {
  const fixedFloatMessage = readString(msg);
  return fixedFloatMessage === undefined
    ? `FixedFloat ${path} failed with HTTP ${status}.`
    : `FixedFloat ${path} failed with HTTP ${status}: ${fixedFloatMessage}`;
}

function assertFixedFloatPayoutAmountMatchesInvoice(
  data: unknown,
  invoiceAmountMsats: number,
): void {
  const toAmount = readNestedString(data, ["to", "amount"]);
  if (toAmount === undefined) {
    throw new Error("FixedFloat create response missing to.amount.");
  }
  const payoutSats = btcAmountStringToSats(toAmount);
  const expectedSats = Math.ceil(invoiceAmountMsats / 1000);
  if (payoutSats === undefined || payoutSats !== expectedSats) {
    throw new Error("FixedFloat create response payout amount did not match the shadow invoice.");
  }
}

function btcAmountStringToSats(value: string): number | undefined {
  if (!/^[0-9]+(\.[0-9]+)?$/.test(value)) return undefined;
  const [wholePart, fractionalPart = ""] = value.split(".");
  if (fractionalPart.length > 8) return undefined;
  const sats = BigInt(wholePart) * 100_000_000n + BigInt(fractionalPart.padEnd(8, "0"));
  return sats <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(sats) : undefined;
}

function normalizeFixedFloatOrder(
  data: unknown,
  input: {
    readonly provider: string;
    readonly payInAsset: SwapPayInAsset;
    readonly fallback?: SwapOrder;
  },
): SwapOrder {
  const record = asRecord(data);
  const from = asRecord(record.from);
  const time = asRecord(record.time);
  const status = readStringField(record, "status") ?? input.fallback?.state ?? "NEW";
  const emergency = asRecord(record.emergency);
  const depositMemo = readStringField(from, "tag") ?? input.fallback?.deposit_memo;
  const depositTxId =
    readNestedString(record, ["from", "tx", "id"]) ?? input.fallback?.deposit_tx_id;
  const payoutTxId = readNestedString(record, ["to", "tx", "id"]) ?? input.fallback?.payout_tx_id;
  const refundTxId =
    readNestedString(record, ["back", "tx", "id"]) ??
    readNestedString(record, ["refund", "tx", "id"]) ??
    input.fallback?.refund_tx_id;
  const normalizedStatus = normalizeFixedFloatStatus(status, emergency, refundTxId);
  const depositAddress =
    readStringField(from, "address") ??
    input.fallback?.deposit_address ??
    requiredString(from.address, "from.address");
  assertFixedFloatDepositAddressShape(input.payInAsset, depositAddress);
  const fee = readFixedFloatOrderFee(record) ?? input.fallback?.fee;
  const emergencyRepeat = readEmergencyRepeat(emergency);
  const depositReceivedAmount =
    readDecimalAmountString(readNestedString(record, ["from", "tx", "amount"])) ??
    input.fallback?.deposit_received_amount;
  const refundAmount =
    readDecimalAmountString(readNestedString(record, ["back", "amount"])) ??
    input.fallback?.refund_amount;
  const refundReason =
    normalizedStatus.refund_reason ??
    (isRefundPathState(normalizedStatus.state) ? input.fallback?.refund_reason : undefined);

  return {
    provider: input.provider,
    provider_order_id:
      readStringField(record, "id") ??
      input.fallback?.provider_order_id ??
      requiredString(record.id, "id"),
    provider_token:
      readStringField(record, "token") ??
      input.fallback?.provider_token ??
      requiredString(record.token, "token"),
    pay_in_asset: input.payInAsset,
    deposit_address: depositAddress,
    ...(depositMemo === undefined ? {} : { deposit_memo: depositMemo }),
    deposit_amount:
      readStringField(from, "amount") ??
      input.fallback?.deposit_amount ??
      requiredString(from.amount, "from.amount"),
    expires_at:
      readUnixSeconds(time.expiration) ??
      input.fallback?.expires_at ??
      Math.floor(Date.now() / 1000) + 600,
    state: normalizedStatus.state,
    ...(depositTxId === undefined ? {} : { deposit_tx_id: depositTxId }),
    ...(payoutTxId === undefined ? {} : { payout_tx_id: payoutTxId }),
    ...(refundTxId === undefined ? {} : { refund_tx_id: refundTxId }),
    ...(normalizedStatus.attention === undefined ? {} : { attention: normalizedStatus.attention }),
    ...(normalizedStatus.attention_reason === undefined
      ? {}
      : { attention_reason: normalizedStatus.attention_reason }),
    ...(refundReason === undefined ? {} : { refund_reason: refundReason }),
    ...(depositReceivedAmount === undefined
      ? {}
      : { deposit_received_amount: depositReceivedAmount }),
    ...(refundAmount === undefined ? {} : { refund_amount: refundAmount }),
    ...(emergencyRepeat === undefined
      ? input.fallback?.emergency_repeat === undefined
        ? {}
        : { emergency_repeat: input.fallback.emergency_repeat }
      : { emergency_repeat: emergencyRepeat }),
    ...(fee === undefined ? {} : { fee }),
    raw: data,
  };
}

// FixedFloat reports the USD equivalents of both sides of the exchange (from.usd is the
// value of the crypto the payer sends, to.usd the value delivered to the merchant). Their
// gap is the swap fee the payer absorbs, so we surface both to explain the price.
function readFixedFloatOrderFee(record: Record<string, unknown>): SwapFee | undefined {
  const payInFiat = readNestedString(record, ["from", "usd"]);
  const payoutFiat = readNestedString(record, ["to", "usd"]);
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
    const choice = readStringField(emergency, "choice")?.toUpperCase();
    const emergencyStatuses = readStringArrayField(emergency, "status").map((item) =>
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
  return { state: "attention", attention: true, attention_reason: "provider_reported_emergency" };
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
  const record = asRecord(data);
  const items = Array.isArray(data)
    ? data
    : Array.isArray(record.ccies)
      ? record.ccies
      : Array.isArray(record.currencies)
        ? record.currencies
        : [];
  const currencies: FixedFloatCurrency[] = [];
  for (const item of items) {
    const record = asRecord(item);
    const code = readStringField(record, "code") ?? readStringField(record, "ticker");
    const coin =
      readStringField(record, "coin") ??
      readStringField(record, "currency") ??
      readStringField(record, "symbol");
    const network =
      readStringField(record, "network") ??
      readStringField(record, "chain") ??
      readStringField(record, "networkName") ??
      readStringField(record, "name");
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

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readNestedString(value: unknown, path: readonly string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    current = asRecord(current)[key];
  }
  return readString(current);
}

function readStringField(
  record: Record<string, unknown> | undefined,
  field: string,
): string | undefined {
  if (record === undefined) return undefined;
  return readString(record[field]);
}

function readStringArrayField(
  record: Record<string, unknown> | undefined,
  field: string,
): readonly string[] {
  if (record === undefined) return [];
  const value = record[field];
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const string = readString(item);
      return string === undefined ? [] : [string];
    });
  }
  const string = readString(value);
  return string === undefined ? [] : [string];
}

function readString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function requiredString(value: unknown, field: string): string {
  const string = readString(value);
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
