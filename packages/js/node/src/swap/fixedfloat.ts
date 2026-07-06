import { createHmac } from "node:crypto";
import {
  getOpenReceiveSwapAssetInfo,
  isOpenReceiveLightningNetwork,
  listOpenReceiveSwapAssetInfo,
  openReceiveSwapNetworkMatches,
  type OpenReceiveSwapPayInAsset,
} from "./assets.ts";
import type {
  OpenReceiveSwapOrder,
  OpenReceiveSwapProvider,
  OpenReceiveSwapProviderState,
  OpenReceiveSwapQuote,
} from "./provider.ts";

export interface FixedFloatProviderOptions {
  readonly key: string;
  readonly secret: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly cacheSeconds?: number;
}

interface FixedFloatCurrency {
  readonly code: string;
  readonly coin: string;
  readonly network: string;
}

interface FixedFloatCurrencyResolution {
  readonly fetched_at: number;
  readonly pay_in: ReadonlyMap<OpenReceiveSwapPayInAsset, string>;
  readonly lightning: string;
}

interface FixedFloatEnvelope {
  readonly code?: unknown;
  readonly msg?: unknown;
  readonly data?: unknown;
}

const DEFAULT_FIXED_FLOAT_BASE_URL = "https://ff.io";
const DEFAULT_CCIES_CACHE_SECONDS = 24 * 60 * 60;

export function fixedFloatProvider(options: FixedFloatProviderOptions): OpenReceiveSwapProvider {
  return new FixedFloatProvider(options);
}

export function createFixedFloatProviderFromEnv(
  env: Record<string, string | undefined> = globalThis.process?.env ?? {},
  options: Omit<FixedFloatProviderOptions, "key" | "secret" | "baseUrl"> = {},
): OpenReceiveSwapProvider | undefined {
  const key = env.FIXED_FLOAT_KEY?.trim();
  const secret = env.FIXED_FLOAT_SECRET?.trim();
  if (key === undefined || key.length === 0 || secret === undefined || secret.length === 0) {
    return undefined;
  }

  return fixedFloatProvider({
    ...options,
    key,
    secret,
    ...(env.FIXED_FLOAT_BASE_URL === undefined || env.FIXED_FLOAT_BASE_URL.trim().length === 0
      ? {}
      : { baseUrl: env.FIXED_FLOAT_BASE_URL.trim() }),
  });
}

class FixedFloatProvider implements OpenReceiveSwapProvider {
  readonly name = "fixedfloat";
  private readonly key: string;
  private readonly secret: string;
  private readonly baseUrl: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly cacheSeconds: number;
  private currencyResolution: FixedFloatCurrencyResolution | undefined;

  constructor(options: FixedFloatProviderOptions) {
    if (options.key.trim().length === 0) {
      throw new TypeError("FixedFloat API key must not be empty.");
    }
    if (options.secret.trim().length === 0) {
      throw new TypeError("FixedFloat API secret must not be empty.");
    }
    const fetcher = options.fetch ?? globalThis.fetch;
    if (fetcher === undefined) {
      throw new TypeError("FixedFloat provider requires fetch.");
    }

    this.key = options.key;
    this.secret = options.secret;
    this.baseUrl = (options.baseUrl ?? DEFAULT_FIXED_FLOAT_BASE_URL).replace(/\/+$/, "");
    this.fetcher = fetcher;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.cacheSeconds = options.cacheSeconds ?? DEFAULT_CCIES_CACHE_SECONDS;
  }

  async supportedPayInAssets(): Promise<Set<OpenReceiveSwapPayInAsset>> {
    const resolution = await this.resolveCurrencies();
    return new Set(resolution.pay_in.keys());
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
        toCcy: resolution.lightning,
        direction: "to",
        amount: amountMsatsToBtcString(input.invoiceAmountMsats),
      });
      return {
        pay_amount: readNestedString(data, ["from", "amount"]) ?? readStringField(asRecord(data), "amount"),
        pay_asset: input.payInAsset,
        min_ok: true,
        max_ok: true,
        provider: this.name,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : String(error);
      return {
        pay_asset: input.payInAsset,
        min_ok: !message.includes("min") && !message.includes("small"),
        max_ok: !message.includes("max") && !message.includes("large"),
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
      toCcy: resolution.lightning,
      direction: "to",
      amount: amountMsatsToBtcString(input.invoiceAmountMsats),
      toAddress: input.bolt11,
    });

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
    const response = await this.fetcher(`${this.baseUrl}/api/v2/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-API-KEY": this.key,
        "X-API-SIGN": createHmac("sha256", this.secret).update(bodyString).digest("hex"),
      },
      body: bodyString,
    });
    const text = await response.text();
    const parsed = text.length === 0 ? {} : JSON.parse(text) as FixedFloatEnvelope;
    if (!response.ok) {
      throw new Error(`FixedFloat ${path} failed with HTTP ${response.status}.`);
    }
    if (parsed.code !== 0) {
      throw new Error(typeof parsed.msg === "string" ? parsed.msg : `FixedFloat ${path} failed.`);
    }
    return parsed.data;
  }

  private async resolveCurrencies(): Promise<FixedFloatCurrencyResolution> {
    const cached = this.currencyResolution;
    const now = this.now();
    if (cached !== undefined && now - cached.fetched_at < this.cacheSeconds) return cached;

    const data = await this.post("ccies", {});
    const currencies = collectFixedFloatCurrencies(data);
    const payIn = new Map<OpenReceiveSwapPayInAsset, string>();
    for (const asset of listOpenReceiveSwapAssetInfo()) {
      const found = currencies.find(
        (currency) =>
          currency.coin.toUpperCase() === asset.coin &&
          openReceiveSwapNetworkMatches(asset.network, currency.network),
      );
      if (found !== undefined) payIn.set(asset.pay_in_asset, found.code);
    }

    const lightning = currencies.find(
      (currency) =>
        currency.coin.toUpperCase() === "BTC" && isOpenReceiveLightningNetwork(currency.network),
    );
    if (lightning === undefined) {
      throw new Error("FixedFloat /ccies did not include a BTC Lightning payout currency.");
    }

    const resolution = {
      fetched_at: now,
      pay_in: payIn,
      lightning: lightning.code,
    };
    this.currencyResolution = resolution;
    return resolution;
  }
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
  return currency;
}

function amountMsatsToBtcString(amountMsats: number): string {
  if (!Number.isSafeInteger(amountMsats) || amountMsats <= 0) {
    throw new RangeError("invoiceAmountMsats must be a positive safe integer.");
  }
  const wholeBtc = Math.floor(amountMsats / 100_000_000_000);
  const fractional = String(amountMsats % 100_000_000_000).padStart(11, "0").replace(/0+$/, "");
  return fractional.length === 0 ? String(wholeBtc) : `${wholeBtc}.${fractional}`;
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
  const depositTxId = readNestedString(record, ["from", "tx", "id"]) ?? input.fallback?.deposit_tx_id;
  const payoutTxId = readNestedString(record, ["to", "tx", "id"]) ?? input.fallback?.payout_tx_id;
  const refundTxId =
    readNestedString(record, ["refund", "tx", "id"]) ?? input.fallback?.refund_tx_id;

  return {
    provider: input.provider,
    provider_order_id:
      readStringField(record, "id") ?? input.fallback?.provider_order_id ?? requiredString(record.id, "id"),
    provider_token:
      readStringField(record, "token") ??
      input.fallback?.provider_token ??
      requiredString(record.token, "token"),
    pay_in_asset: input.payInAsset,
    deposit_address:
      readStringField(from, "address") ??
      input.fallback?.deposit_address ??
      requiredString(from.address, "from.address"),
    ...(depositMemo === undefined ? {} : { deposit_memo: depositMemo }),
    deposit_amount:
      readStringField(from, "amount") ??
      input.fallback?.deposit_amount ??
      requiredString(from.amount, "from.amount"),
    expires_at:
      readUnixSeconds(time.expiration) ??
      input.fallback?.expires_at ??
      Math.floor(Date.now() / 1000) + 600,
    state: normalizeFixedFloatStatus(status, emergency),
    ...(depositTxId === undefined ? {} : { deposit_tx_id: depositTxId }),
    ...(payoutTxId === undefined ? {} : { payout_tx_id: payoutTxId }),
    ...(refundTxId === undefined ? {} : { refund_tx_id: refundTxId }),
    raw: data,
  };
}

function normalizeFixedFloatStatus(
  status: string,
  emergency: Record<string, unknown> | undefined,
): OpenReceiveSwapProviderState {
  const normalized = status.toUpperCase();
  if (normalized === "NEW") return "awaiting_deposit";
  if (normalized === "PENDING") return "confirming";
  if (normalized === "EXCHANGE") return "exchanging";
  if (normalized === "WITHDRAW") return "paying_invoice";
  if (normalized === "DONE") return "completed";
  if (normalized === "EXPIRED") return "expired";
  if (normalized === "EMERGENCY") {
    const emergencyStatus = readStringField(emergency, "status")?.toUpperCase();
    if (emergencyStatus === "REFUND" || emergencyStatus === "REFUNDED") return "refund_pending";
    return "refund_required";
  }
  if (normalized.includes("FAIL")) return "failed";
  return "attention";
}

function collectFixedFloatCurrencies(data: unknown): FixedFloatCurrency[] {
  const currencies: FixedFloatCurrency[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== "object") return;

    const record = value as Record<string, unknown>;
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
      });
    }

    for (const item of Object.values(record)) visit(item);
  };
  visit(data);
  return currencies;
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

function readStringField(record: Record<string, unknown> | undefined, field: string): string | undefined {
  if (record === undefined) return undefined;
  return readString(record[field]);
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
