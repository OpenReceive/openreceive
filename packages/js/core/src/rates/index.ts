export const OPENRECEIVE_RATE_CACHE_SECONDS = 30 as const;
export const OPENRECEIVE_INVOICE_QUOTE_TTL_SECONDS = 600 as const;

export const OPENRECEIVE_PRICE_SOURCE_IDS = [
  "static_mock",
  "openreceive_mirror",
  "megalithic_mirror",
  "coingecko_direct"
] as const;

export type OpenReceivePriceSourceId = (typeof OPENRECEIVE_PRICE_SOURCE_IDS)[number];

export const OPENRECEIVE_STATIC_PRICE_SOURCE_ID = "static_mock" as const;

export const OPENRECEIVE_STATIC_BTC_FIAT_RATES = {
  bitcoin: {
    usd: "50000.00"
  }
} as const;

export const OPENRECEIVE_COINGECKO_DIRECT_BASE_URL =
  "https://api.coingecko.com/api/v3/simple/price" as const;
export const OPENRECEIVE_RATE_MIRROR_URL =
  "https://openreceive.org/exchange_rates" as const;
export const OPENRECEIVE_MEGALITHIC_RATE_MIRROR_URL =
  "https://megalithic.me/exchange_rates" as const;

export const OPENRECEIVE_SATS_PER_BTC = 100_000_000n;
export const OPENRECEIVE_MSATS_PER_SAT = 1000n;
export const OPENRECEIVE_MIN_AMOUNT_SATS = 1n;
export const OPENRECEIVE_MAX_AMOUNT_SATS = 9_007_199_254_740n;
export const OPENRECEIVE_MIN_AMOUNT_MSATS = 1000n;
export const OPENRECEIVE_MAX_AMOUNT_MSATS = 9_007_199_254_740_991n;

export interface OpenReceiveFiatAmount {
  currency: string;
  value: string;
}

export interface OpenReceiveBitcoinAmount {
  currency: "BTC" | "SAT" | "SATS";
  value: string;
}

export interface OpenReceiveDirectAmountQuote {
  amount_sats: number;
  amount_msats: number;
}

export interface OpenReceiveRateQuote {
  fiat: OpenReceiveFiatAmount;
  btc_fiat_price: string;
  amount_sats: number;
  amount_msats: number;
  source: OpenReceivePriceSourceId;
  as_of: number;
  expires_at: number;
}

export interface QuoteFiatToMsatsRequest {
  fiat: OpenReceiveFiatAmount;
  as_of?: number;
}

export interface QuoteFiatToMsatsWithPriceRequest extends QuoteFiatToMsatsRequest {
  btc_fiat_price: string;
  source: OpenReceivePriceSourceId;
  ttl_seconds?: number;
}

export interface OpenReceiveBtcFiatRateMap {
  bitcoin: Record<string, string>;
}

export interface OpenReceivePriceProvider {
  getBtcFiatRates(currencies: readonly string[]): Promise<OpenReceiveBtcFiatRateMap>;
}

export interface OpenReceiveSourcedPriceProvider extends OpenReceivePriceProvider {
  readonly source: OpenReceivePriceSourceId;
}

export interface OpenReceiveBtcFiatRateMapWithSource {
  readonly source: OpenReceivePriceSourceId;
  readonly rates: OpenReceiveBtcFiatRateMap;
}

export interface CoinGeckoSimplePriceResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type CoinGeckoSimplePriceFetch = (
  url: string,
  init?: {
    headers?: Record<string, string>;
  }
) => Promise<CoinGeckoSimplePriceResponse>;

export interface CoinGeckoSimplePriceProviderOptions {
  url: string;
  source: Exclude<OpenReceivePriceSourceId, "static_mock">;
  fetch?: CoinGeckoSimplePriceFetch;
}

interface ParsedDecimal {
  integer: bigint;
  scale: bigint;
}

const DECIMAL_PATTERN = /^[0-9]+(\.[0-9]+)?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

function parseDecimal(value: string, fieldName: string): ParsedDecimal {
  if (!DECIMAL_PATTERN.test(value)) {
    throw new RangeError(`${fieldName} must be a non-negative decimal string`);
  }

  const [whole, fraction = ""] = value.split(".");

  return {
    integer: BigInt(`${whole}${fraction}`),
    scale: 10n ** BigInt(fraction.length)
  };
}

function assertPositiveDecimal(value: string, fieldName: string): void {
  const parsed = parseDecimal(value, fieldName);
  if (parsed.integer <= 0n) {
    throw new RangeError(`${fieldName} must be greater than 0`);
  }
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function toSafeJsonInteger(value: bigint, fieldName: string): number {
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);

  if (value > maximum) {
    throw new RangeError(`${fieldName} exceeds JSON safe integer boundary`);
  }

  return Number(value);
}

function normalizeUnixSeconds(value: number, fieldName: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${fieldName} must be a non-negative safe integer`);
  }

  return value;
}

function currentUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function normalizeFiatCurrency(currency: string): string {
  if (!CURRENCY_PATTERN.test(currency)) {
    throw new RangeError("fiat.currency must be an ISO 4217 uppercase code");
  }

  return currency.toLowerCase();
}

function assertAmountBounds(amountSats: bigint, amountMsats: bigint): void {
  if (amountSats < OPENRECEIVE_MIN_AMOUNT_SATS) {
    throw new RangeError("amount_sats must be at least 1");
  }

  if (amountSats > OPENRECEIVE_MAX_AMOUNT_SATS) {
    throw new RangeError("amount_sats exceeds JSON safe integer boundary");
  }

  if (amountMsats < OPENRECEIVE_MIN_AMOUNT_MSATS) {
    throw new RangeError("amount_msats must be at least 1000");
  }

  if (amountMsats > OPENRECEIVE_MAX_AMOUNT_MSATS) {
    throw new RangeError("amount_msats exceeds JSON safe integer boundary");
  }
}

export function isOpenReceiveBitcoinAmountCurrency(currency: string): currency is OpenReceiveBitcoinAmount["currency"] {
  return currency === "BTC" || currency === "SAT" || currency === "SATS";
}

export function quoteBitcoinAmountToMsats(
  amount: OpenReceiveBitcoinAmount
): OpenReceiveDirectAmountQuote {
  const parsed = parseDecimal(amount.value, "amount.value");
  let amountSats: bigint;
  let amountMsats: bigint;

  if (amount.currency === "BTC") {
    const numerator = parsed.integer * OPENRECEIVE_SATS_PER_BTC;
    if (numerator % parsed.scale !== 0n) {
      throw new RangeError("BTC amount cannot be more precise than satoshis");
    }
    amountSats = numerator / parsed.scale;
    amountMsats = amountSats * OPENRECEIVE_MSATS_PER_SAT;
  } else {
    if (parsed.integer % parsed.scale !== 0n) {
      throw new RangeError("SATS amount must be a whole number of satoshis");
    }
    amountSats = parsed.integer / parsed.scale;
    amountMsats = amountSats * OPENRECEIVE_MSATS_PER_SAT;
  }

  assertAmountBounds(amountSats, amountMsats);

  return {
    amount_sats: toSafeJsonInteger(amountSats, "amount_sats"),
    amount_msats: toSafeJsonInteger(amountMsats, "amount_msats")
  };
}

export function getStaticBtcFiatPrice(currency: string): string {
  const rateKey = normalizeFiatCurrency(currency) as keyof typeof OPENRECEIVE_STATIC_BTC_FIAT_RATES.bitcoin;
  const rate = OPENRECEIVE_STATIC_BTC_FIAT_RATES.bitcoin[rateKey];

  if (rate === undefined) {
    throw new RangeError(`unsupported static fiat currency: ${currency}`);
  }

  return rate;
}

export function quoteFiatValueToWholeSats(fiatValue: string, btcFiatPrice: string): bigint {
  const fiat = parseDecimal(fiatValue, "fiat.value");
  const price = parseDecimal(btcFiatPrice, "btc_fiat_price");

  if (price.integer <= 0n) {
    throw new RangeError("btc_fiat_price must be greater than 0");
  }

  const numerator = fiat.integer * price.scale * OPENRECEIVE_SATS_PER_BTC;
  const denominator = price.integer * fiat.scale;

  return ceilDiv(numerator, denominator);
}

export function quoteFiatToMsatsWithPrice(
  request: QuoteFiatToMsatsWithPriceRequest
): OpenReceiveRateQuote {
  if (request.fiat === undefined) {
    throw new RangeError("fiat is required");
  }

  const fiat = request.fiat;
  if (!CURRENCY_PATTERN.test(fiat.currency)) {
    throw new RangeError("fiat.currency must be an ISO 4217 uppercase code");
  }

  const btcFiatPrice = request.btc_fiat_price;
  const amountSats = quoteFiatValueToWholeSats(fiat.value, btcFiatPrice);
  const amountMsats = amountSats * OPENRECEIVE_MSATS_PER_SAT;

  assertAmountBounds(amountSats, amountMsats);

  const asOf = normalizeUnixSeconds(request.as_of ?? currentUnixSeconds(), "as_of");
  const ttlSeconds = normalizeUnixSeconds(
    request.ttl_seconds ?? OPENRECEIVE_INVOICE_QUOTE_TTL_SECONDS,
    "ttl_seconds"
  );
  const expiresAt = normalizeUnixSeconds(asOf + ttlSeconds, "expires_at");

  return {
    fiat: {
      currency: fiat.currency,
      value: fiat.value
    },
    btc_fiat_price: btcFiatPrice,
    amount_sats: toSafeJsonInteger(amountSats, "amount_sats"),
    amount_msats: toSafeJsonInteger(amountMsats, "amount_msats"),
    source: request.source,
    as_of: asOf,
    expires_at: expiresAt
  };
}

export function quoteFiatToMsats(request: QuoteFiatToMsatsRequest): OpenReceiveRateQuote {
  return quoteFiatToMsatsWithPrice({
    ...request,
    btc_fiat_price: getStaticBtcFiatPrice(request.fiat.currency),
    source: OPENRECEIVE_STATIC_PRICE_SOURCE_ID
  });
}

export class StaticPriceProvider implements OpenReceiveSourcedPriceProvider {
  readonly source = OPENRECEIVE_STATIC_PRICE_SOURCE_ID;

  async getBtcFiatRates(
    currencies: readonly string[]
  ): Promise<OpenReceiveBtcFiatRateMap> {
    const rates: Record<string, string> = {};

    for (const currency of currencies) {
      const rateKey = normalizeFiatCurrency(currency);
      rates[rateKey] = getStaticBtcFiatPrice(currency);
    }

    return {
      bitcoin: rates
    };
  }
}

export function createCoinGeckoSimplePriceUrl(
  currencies: readonly string[],
  baseUrl = OPENRECEIVE_COINGECKO_DIRECT_BASE_URL
): string {
  if (currencies.length === 0) {
    throw new RangeError("at least one fiat currency is required");
  }

  const normalizedCurrencies = currencies.map((currency) =>
    normalizeFiatCurrency(currency)
  );
  const url = new URL(baseUrl);
  url.searchParams.set("ids", "bitcoin");
  url.searchParams.set("vs_currencies", normalizedCurrencies.join(","));
  return url.toString();
}

export function parseCoinGeckoSimplePriceResponse(
  response: unknown,
  currencies: readonly string[]
): OpenReceiveBtcFiatRateMap {
  const bitcoin = asRecord(asRecord(response).bitcoin);
  const rates: Record<string, string> = {};

  for (const currency of currencies) {
    const rateKey = normalizeFiatCurrency(currency);
    const rawRate = bitcoin[rateKey];
    const normalizedRate = normalizeBtcFiatRate(rawRate, `bitcoin.${rateKey}`);
    rates[rateKey] = normalizedRate;
  }

  return {
    bitcoin: rates
  };
}

export class CoinGeckoSimplePriceProvider implements OpenReceiveSourcedPriceProvider {
  readonly url: string;
  readonly source: Exclude<OpenReceivePriceSourceId, "static_mock">;
  #fetch: CoinGeckoSimplePriceFetch;

  constructor(options: CoinGeckoSimplePriceProviderOptions) {
    this.url = options.url;
    this.source = options.source;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async getBtcFiatRates(currencies: readonly string[]): Promise<OpenReceiveBtcFiatRateMap> {
    const response = await this.#fetch(this.url, {
      headers: {
        accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`price source ${this.source} returned HTTP ${response.status}`);
    }

    return parseCoinGeckoSimplePriceResponse(JSON.parse(await response.text()), currencies);
  }
}

export function createCoinGeckoDirectPriceProvider(options: {
  currencies: readonly string[];
  fetch?: CoinGeckoSimplePriceFetch;
}): CoinGeckoSimplePriceProvider {
  return new CoinGeckoSimplePriceProvider({
    url: createCoinGeckoSimplePriceUrl(options.currencies),
    source: "coingecko_direct",
    fetch: options.fetch
  });
}

export function createOpenReceiveMirrorPriceProvider(options: {
  fetch?: CoinGeckoSimplePriceFetch;
} = {}): CoinGeckoSimplePriceProvider {
  return new CoinGeckoSimplePriceProvider({
    url: OPENRECEIVE_RATE_MIRROR_URL,
    source: "openreceive_mirror",
    fetch: options.fetch
  });
}

export function createMegalithicMirrorPriceProvider(options: {
  fetch?: CoinGeckoSimplePriceFetch;
} = {}): CoinGeckoSimplePriceProvider {
  return new CoinGeckoSimplePriceProvider({
    url: OPENRECEIVE_MEGALITHIC_RATE_MIRROR_URL,
    source: "megalithic_mirror",
    fetch: options.fetch
  });
}

export function createDefaultLivePriceProviders(options: {
  currencies: readonly string[];
  fetch?: CoinGeckoSimplePriceFetch;
}): readonly OpenReceiveSourcedPriceProvider[] {
  return [
    createOpenReceiveMirrorPriceProvider({ fetch: options.fetch }),
    createMegalithicMirrorPriceProvider({ fetch: options.fetch }),
    createCoinGeckoDirectPriceProvider({
      currencies: options.currencies,
      fetch: options.fetch
    })
  ];
}

export function createDefaultPriceProviders(options: {
  currencies: readonly string[];
  fetch?: CoinGeckoSimplePriceFetch;
  includeStatic?: boolean;
}): readonly OpenReceiveSourcedPriceProvider[] {
  return [
    ...(options.includeStatic === false ? [] : [new StaticPriceProvider()]),
    ...createDefaultLivePriceProviders({
      currencies: options.currencies,
      fetch: options.fetch
    })
  ];
}

export async function getBtcFiatRatesWithFallback(input: {
  currencies: readonly string[];
  providers: readonly OpenReceiveSourcedPriceProvider[];
}): Promise<OpenReceiveBtcFiatRateMapWithSource> {
  if (input.providers.length === 0) {
    throw new Error("at least one price provider is required");
  }

  const failures: string[] = [];
  for (const provider of input.providers) {
    try {
      return {
        source: provider.source,
        rates: await provider.getBtcFiatRates(input.currencies)
      };
    } catch (error) {
      failures.push(`${provider.source}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`all price providers failed: ${failures.join("; ")}`);
}

export async function quoteFiatToMsatsWithProvider(input: {
  fiat: OpenReceiveFiatAmount;
  provider: OpenReceiveSourcedPriceProvider;
  as_of?: number;
  ttl_seconds?: number;
}): Promise<OpenReceiveRateQuote> {
  const rates = await input.provider.getBtcFiatRates([input.fiat.currency]);
  const rateKey = normalizeFiatCurrency(input.fiat.currency);
  const btcFiatPrice = rates.bitcoin[rateKey];
  if (btcFiatPrice === undefined) {
    throw new RangeError(`price provider ${input.provider.source} did not return ${input.fiat.currency}`);
  }

  return quoteFiatToMsatsWithPrice({
    fiat: input.fiat,
    btc_fiat_price: btcFiatPrice,
    source: input.provider.source,
    as_of: input.as_of,
    ttl_seconds: input.ttl_seconds
  });
}

function normalizeBtcFiatRate(value: unknown, fieldName: string): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`${fieldName} must be a positive number`);
    }
    const normalized = numberToPlainDecimalString(value);
    assertPositiveDecimal(normalized, fieldName);
    return normalized;
  }

  if (typeof value === "string") {
    assertPositiveDecimal(value, fieldName);
    return value;
  }

  throw new RangeError(`${fieldName} must be a number or decimal string`);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError("expected object");
  }

  return value as Record<string, unknown>;
}

// Expand a positive finite JS number to plain decimal notation so any integer
// or decimal JSON number an upstream price source returns is accepted, even
// when Number.toString() would emit exponential form (>= 1e21 or < 1e-6).
function numberToPlainDecimalString(value: number): string {
  const text = value.toString();
  if (!/[eE]/.test(text)) return text;

  const [mantissa, exponentText] = text.split(/[eE]/);
  const exponent = Number(exponentText);
  const [intPart, fractionPart = ""] = mantissa.split(".");
  const digits = `${intPart}${fractionPart}`;
  const pointIndex = intPart.length + exponent;

  let result: string;
  if (pointIndex <= 0) {
    result = `0.${"0".repeat(-pointIndex)}${digits}`;
  } else if (pointIndex >= digits.length) {
    result = `${digits}${"0".repeat(pointIndex - digits.length)}`;
  } else {
    result = `${digits.slice(0, pointIndex)}.${digits.slice(pointIndex)}`;
  }

  if (result.includes(".")) {
    result = result.replace(/0+$/, "").replace(/\.$/, "");
  }

  return result;
}
