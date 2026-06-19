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

export interface OpenReceiveRateQuote {
  fiat: OpenReceiveFiatAmount;
  btc_fiat_price: string;
  amount_sats: number;
  amount_msats: number;
  source: typeof OPENRECEIVE_STATIC_PRICE_SOURCE_ID;
  as_of: number;
  expires_at: number;
}

export interface QuoteFiatToMsatsRequest {
  fiat: OpenReceiveFiatAmount;
  as_of?: number;
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

export function getStaticBtcFiatPrice(currency: string): string {
  if (!CURRENCY_PATTERN.test(currency)) {
    throw new RangeError("fiat.currency must be an ISO 4217 uppercase code");
  }

  const rateKey = currency.toLowerCase() as keyof typeof OPENRECEIVE_STATIC_BTC_FIAT_RATES.bitcoin;
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

export function quoteFiatToMsats(request: QuoteFiatToMsatsRequest): OpenReceiveRateQuote {
  if (request.fiat === undefined) {
    throw new RangeError("fiat is required");
  }

  const fiat = request.fiat;
  const btcFiatPrice = getStaticBtcFiatPrice(fiat.currency);
  const amountSats = quoteFiatValueToWholeSats(fiat.value, btcFiatPrice);
  const amountMsats = amountSats * OPENRECEIVE_MSATS_PER_SAT;

  assertAmountBounds(amountSats, amountMsats);

  const asOf = normalizeUnixSeconds(request.as_of ?? currentUnixSeconds(), "as_of");
  const expiresAt = normalizeUnixSeconds(asOf + OPENRECEIVE_INVOICE_QUOTE_TTL_SECONDS, "expires_at");

  return {
    fiat: {
      currency: fiat.currency,
      value: fiat.value
    },
    btc_fiat_price: btcFiatPrice,
    amount_sats: toSafeJsonInteger(amountSats, "amount_sats"),
    amount_msats: toSafeJsonInteger(amountMsats, "amount_msats"),
    source: OPENRECEIVE_STATIC_PRICE_SOURCE_ID,
    as_of: asOf,
    expires_at: expiresAt
  };
}
