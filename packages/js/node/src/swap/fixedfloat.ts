import { createHmac } from "node:crypto";
import {
  getOpenReceiveSwapAssetInfo,
  isOpenReceiveLightningNetwork,
  isValidSwapAddressForNetwork,
  listOpenReceiveSwapAssetInfo,
  openReceiveSwapNetworkMatches,
  type OpenReceiveSwapPayInAsset,
} from "./assets.ts";
import type {
  OpenReceiveSwapAttentionReason,
  OpenReceiveSwapAvailabilityReason,
  OpenReceiveSwapOrder,
  OpenReceiveSwapProviderAsset,
  OpenReceiveSwapProvider,
  OpenReceiveSwapProviderState,
  OpenReceiveSwapQuote,
} from "./provider.ts";

export interface FixedFloatProviderOptions {
  readonly key: string;
  readonly secret: string;
  readonly baseUrl?: string;
  readonly lightningCcy?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly cacheSeconds?: number;
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
  readonly minimum_send_amount?: string;
  readonly maximum_send_amount?: string;
  readonly minimum_receive_amount?: string;
  readonly maximum_receive_amount?: string;
}

interface FixedFloatCurrencyResolution {
  readonly fetched_at: number;
  readonly pay_in: ReadonlyMap<OpenReceiveSwapPayInAsset, FixedFloatCurrency>;
  readonly lightning: FixedFloatCurrency;
}

interface FixedFloatEnvelope {
  readonly code?: unknown;
  readonly msg?: unknown;
  readonly data?: unknown;
}

interface FixedFloatDataError {
  readonly code: string;
  readonly message?: string;
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
const DEFAULT_FIXED_FLOAT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_FIXED_FLOAT_DEPOSIT_WINDOW_SECONDS = 10 * 60;
const DEFAULT_FIXED_FLOAT_SETTLEMENT_SLA_SECONDS = 15 * 60;
const DEFAULT_FIXED_FLOAT_INVOICE_EXPIRY_MARGIN_SECONDS = 2 * 60;

export function fixedFloatProvider(options: FixedFloatProviderOptions): OpenReceiveSwapProvider {
  return fixedFloatCompatibleSwapProvider({
    ...options,
    id: "fixedfloat",
  });
}

export function fixedFloatCompatibleSwapProvider(
  options: FixedFloatCompatibleSwapProviderOptions,
): OpenReceiveSwapProvider {
  return new FixedFloatProvider(options);
}

class FixedFloatProvider implements OpenReceiveSwapProvider {
  readonly name: string;
  private readonly key: string;
  private readonly secret: string;
  private readonly baseUrl: string;
  private readonly lightningCcy: string | undefined;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly cacheSeconds: number;
  private readonly requestTimeoutMs: number;
  private readonly invoiceExpirySecondsValue: number;
  private currencyResolution: FixedFloatCurrencyResolution | undefined;

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

  async supportedPayInAssets(): Promise<Set<OpenReceiveSwapPayInAsset>> {
    const resolution = await this.resolveCurrencies();
    return new Set(resolution.pay_in.keys());
  }

  async payInAssetCatalog(): Promise<readonly OpenReceiveSwapProviderAsset[]> {
    const resolution = await this.resolveCurrencies();
    const minimumInvoiceAmountMsats = btcAmountStringToMsats(
      resolution.lightning.minimum_receive_amount ?? resolution.lightning.minimum_send_amount ?? "",
    );
    const maximumInvoiceAmountMsats = btcAmountStringToMsats(
      resolution.lightning.maximum_receive_amount ?? resolution.lightning.maximum_send_amount ?? "",
    );
    return Array.from(resolution.pay_in.entries(), ([payInAsset, currency]) => ({
      pay_asset: payInAsset,
      ...(currency.minimum_send_amount === undefined
        ? {}
        : { minimum_pay_amount: currency.minimum_send_amount }),
      ...(currency.maximum_send_amount === undefined
        ? {}
        : { maximum_pay_amount: currency.maximum_send_amount }),
      ...(minimumInvoiceAmountMsats === undefined
        ? {}
        : { minimum_invoice_amount_msats: minimumInvoiceAmountMsats }),
      ...(maximumInvoiceAmountMsats === undefined
        ? {}
        : { maximum_invoice_amount_msats: maximumInvoiceAmountMsats }),
    }));
  }

  invoiceExpirySeconds(): number {
    return this.invoiceExpirySecondsValue;
  }

  async quote(input: {
    readonly payInAsset: OpenReceiveSwapPayInAsset;
    readonly invoiceAmountMsats: number;
  }): Promise<OpenReceiveSwapQuote> {
    const resolution = await this.resolveCurrencies();
    const fromCcy = requiredCurrency(resolution, input.payInAsset);
    try {
      const data = await this.post("price", {
        type: "fixed",
        fromCcy,
        toCcy: resolution.lightning.code,
        direction: "to",
        amount: amountMsatsToBtcString(input.invoiceAmountMsats),
      });
      const limits = readFixedFloatQuoteLimits(data);
      const dataErrors = readFixedFloatDataErrors(data);
      if (dataErrors.length > 0) {
        const reason = classifyFixedFloatDataErrors(dataErrors);
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
        pay_amount:
          readNestedString(data, ["from", "amount"]) ?? readStringField(asRecord(data), "amount"),
        pay_asset: input.payInAsset,
        available: true,
        provider: this.name,
        ...limits,
      };
    } catch (error) {
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
    readonly payInAsset: OpenReceiveSwapPayInAsset;
    readonly bolt11: string;
    readonly invoiceAmountMsats: number;
  }): Promise<OpenReceiveSwapOrder> {
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

    return normalizeFixedFloatOrder(data, {
      provider: this.name,
      payInAsset: input.payInAsset,
    });
  }

  async getStatus(order: OpenReceiveSwapOrder): Promise<OpenReceiveSwapOrder> {
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

  async requestRefund(order: OpenReceiveSwapOrder, refundAddress: string): Promise<void> {
    await this.post("emergency", {
      id: order.provider_order_id,
      token: order.provider_token,
      choice: "REFUND",
      address: refundAddress,
    });
  }

  private async post(path: string, body: Record<string, unknown>): Promise<unknown> {
    const bodyString = JSON.stringify(body);
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
    if (!response.ok) {
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
    const cached = this.currencyResolution;
    const now = this.now();
    if (cached !== undefined && now - cached.fetched_at < this.cacheSeconds) return cached;

    const data = await this.post("ccies", {});
    const currencies = readFixedFloatCurrencies(data);
    const payIn = new Map<OpenReceiveSwapPayInAsset, FixedFloatCurrency>();
    for (const asset of listOpenReceiveSwapAssetInfo()) {
      const found = currencies.find(
        (currency) =>
          currency.coin.toUpperCase() === asset.coin &&
          openReceiveSwapNetworkMatches(asset.network, currency.network),
      );
      if (found !== undefined) payIn.set(asset.pay_in_asset, found);
    }

    const lightningCurrency =
      this.lightningCcy === undefined
        ? currencies.find(
            (currency) =>
              currency.coin.toUpperCase() === "BTC" &&
              isOpenReceiveLightningNetwork(currency.network),
          )
        : currencies.find((currency) => currency.code === this.lightningCcy);
    if (lightningCurrency === undefined) {
      throw new Error("FixedFloat /ccies did not include a BTC Lightning payout currency.");
    }

    const resolution = {
      fetched_at: now,
      pay_in: payIn,
      lightning: lightningCurrency,
    };
    this.currencyResolution = resolution;
    return resolution;
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

function requiredCurrency(
  resolution: FixedFloatCurrencyResolution,
  payInAsset: OpenReceiveSwapPayInAsset,
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

function classifyFixedFloatQuoteError(error: unknown): OpenReceiveSwapAvailabilityReason {
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
    if (message.includes("min") || message.includes("small")) return "amount_too_small";
    if (message.includes("max") || message.includes("large")) return "amount_too_large";
    return "pair_temporarily_unavailable";
  }
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("rate") || message.includes("429")) return "provider_rate_limited";
  if (message.includes("fetch") || message.includes("network") || message.includes("timeout")) {
    return "provider_unreachable";
  }
  if (message.includes("min") || message.includes("small")) return "amount_too_small";
  if (message.includes("max") || message.includes("large")) return "amount_too_large";
  return "pair_temporarily_unavailable";
}

function classifyFixedFloatDataErrors(
  errors: readonly FixedFloatDataError[],
): OpenReceiveSwapAvailabilityReason {
  if (errors.some((error) => error.code === "LIMIT_MIN")) return "amount_too_small";
  if (errors.some((error) => error.code === "LIMIT_MAX")) return "amount_too_large";
  return "pair_temporarily_unavailable";
}

function fixedFloatAvailabilityMessage(reason: OpenReceiveSwapAvailabilityReason): string {
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

function readFixedFloatQuoteLimits(data: unknown): {
  readonly minimum_pay_amount?: string;
  readonly maximum_pay_amount?: string;
} {
  const minimumPayAmount = readNestedString(data, ["from", "min"]);
  const maximumPayAmount = readNestedString(data, ["from", "max"]);
  return {
    ...(minimumPayAmount === undefined ? {} : { minimum_pay_amount: minimumPayAmount }),
    ...(maximumPayAmount === undefined ? {} : { maximum_pay_amount: maximumPayAmount }),
  };
}

function readFixedFloatDataErrors(data: unknown): FixedFloatDataError[] {
  const errors = asRecord(data).errors;
  if (!Array.isArray(errors)) return [];
  return errors.flatMap((item): FixedFloatDataError[] => {
    if (typeof item === "string" && item.trim().length > 0) {
      return [{ code: item.trim().toUpperCase() }];
    }
    const record = asRecord(item);
    const code = readStringField(record, "code") ?? readStringField(record, "type");
    if (code === undefined) return [];
    const message = readStringField(record, "msg") ?? readStringField(record, "message");
    return [
      {
        code: code.toUpperCase(),
        ...(message === undefined ? {} : { message }),
      },
    ];
  });
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

function btcAmountStringToMsats(value: string): number | undefined {
  const sats = btcAmountStringToSats(value);
  if (sats === undefined) return undefined;
  const msats = sats * 1000;
  return Number.isSafeInteger(msats) ? msats : undefined;
}

function normalizeFixedFloatOrder(
  data: unknown,
  input: {
    readonly provider: string;
    readonly payInAsset: OpenReceiveSwapPayInAsset;
    readonly fallback?: OpenReceiveSwapOrder;
  },
): OpenReceiveSwapOrder {
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
    raw: data,
  };
}

function assertFixedFloatDepositAddressShape(
  payInAsset: OpenReceiveSwapPayInAsset,
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
  readonly state: OpenReceiveSwapProviderState;
  readonly attention?: boolean;
  readonly attention_reason?: OpenReceiveSwapAttentionReason;
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
    if (choice === "REFUND" && refundTxId !== undefined) return { state: "refunded" };
    if (choice === "REFUND") return { state: "refund_pending" };
    if (choice === "EXCHANGE") {
      return { state: "attention", attention: true, attention_reason: "provider_reported_emergency" };
    }
    if (
      emergencyStatuses.includes("MORE") ||
      emergencyStatuses.includes("OVER") ||
      emergencyStatuses.includes("OVERPAID")
    ) {
      return { state: "attention", attention: true, attention_reason: "provider_reported_emergency" };
    }
    return { state: "refund_required" };
  }
  if (normalized.includes("FAIL")) return { state: "failed" };
  return { state: "attention", attention: true, attention_reason: "provider_reported_emergency" };
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
        ...readFixedFloatCurrencyLimits(record),
      });
    }
  }
  return currencies;
}

function readFixedFloatCurrencyLimits(record: Record<string, unknown>): {
  readonly minimum_send_amount?: string;
  readonly maximum_send_amount?: string;
  readonly minimum_receive_amount?: string;
  readonly maximum_receive_amount?: string;
} {
  const send = asRecord(record.send);
  const from = asRecord(record.from);
  const receive = asRecord(record.recv ?? record.receive);
  const to = asRecord(record.to);
  return {
    ...firstStringField(
      [
        [send, "min"],
        [send, "minimum"],
        [from, "min"],
        [from, "minimum"],
        [record, "send_min"],
        [record, "min_send"],
        [record, "min"],
        [record, "minimum"],
        [record, "minAmount"],
        [record, "minimumAmount"],
      ],
      "minimum_send_amount",
    ),
    ...firstStringField(
      [
        [send, "max"],
        [send, "maximum"],
        [from, "max"],
        [from, "maximum"],
        [record, "send_max"],
        [record, "max_send"],
        [record, "max"],
        [record, "maximum"],
        [record, "maxAmount"],
        [record, "maximumAmount"],
      ],
      "maximum_send_amount",
    ),
    ...firstStringField(
      [
        [receive, "min"],
        [receive, "minimum"],
        [to, "min"],
        [to, "minimum"],
        [record, "recv_min"],
        [record, "receive_min"],
        [record, "min_receive"],
      ],
      "minimum_receive_amount",
    ),
    ...firstStringField(
      [
        [receive, "max"],
        [receive, "maximum"],
        [to, "max"],
        [to, "maximum"],
        [record, "recv_max"],
        [record, "receive_max"],
        [record, "max_receive"],
      ],
      "maximum_receive_amount",
    ),
  };
}

function firstStringField<K extends string>(
  candidates: readonly (readonly [Record<string, unknown>, string])[],
  outputKey: K,
): { readonly [P in K]?: string } {
  for (const [record, field] of candidates) {
    const value = readStringField(record, field);
    if (value !== undefined) return { [outputKey]: value } as { readonly [P in K]?: string };
  }
  return {};
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
