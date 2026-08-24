/**
 * Exact integer/decimal money math for OpenReceive — the one decimal engine.
 *
 * Uses bigint only, never binary floats. Rate quoting (`../rates/index.ts`) and
 * the Node swap providers parse, divide, and format through these helpers so a
 * single rounding rule applies to every amount OpenReceive prices.
 *
 * Two error domains, kept distinct so a transport can map them without
 * guessing which side was at fault:
 * - {@link DecimalError} extends `RangeError` — the caller (host or
 *   payer) supplied a value outside the accepted domain. Maps to 400.
 * - {@link PriceFeedError} is deliberately NOT a `RangeError` — a
 *   price feed answered with data we cannot price from. Maps to a retryable
 *   503, because a feed being unusable is an outage, never payer input.
 */

/** Caller/payer input outside the accepted domain. */
export class DecimalError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "DecimalError";
  }
}

/** Price-feed data OpenReceive cannot price from (missing, malformed, or non-positive). */
export class PriceFeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PriceFeedError";
  }
}

export const OPENRECEIVE_SATS_PER_BTC = 100_000_000n;
export const OPENRECEIVE_MSATS_PER_SAT = 1000n;

export interface Decimal {
  readonly units: bigint;
  readonly scale: number;
}

/** A currency-tagged decimal amount. `currency` is fiat, or `BTC`/`SAT`/`SATS`. */
export interface MoneyAmount {
  readonly currency: string;
  readonly value: string;
}

export interface BitcoinAmount {
  readonly currency: "BTC" | "SAT" | "SATS";
  readonly value: string;
}

/** BTC prices keyed by lowercase ISO 4217 code, in units of fiat per 1 BTC. */
export interface BtcFiatRateMap {
  readonly bitcoin: Readonly<Record<string, string>>;
}

const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/;

/**
 * Parse a non-negative decimal string into integer units + scale.
 *
 * @throws {DecimalError} when `value` is not a non-negative decimal.
 */
export function parseDecimal(value: string, fieldName = "Amount"): Decimal {
  if (!DECIMAL_PATTERN.test(value)) {
    throw new DecimalError(`${fieldName} must be a non-negative decimal string.`);
  }
  const [integer, fraction = ""] = value.split(".");
  return {
    units: BigInt(`${integer}${fraction}`),
    scale: fraction.length,
  };
}

/**
 * `10 ** scale` as a bigint — the multiplier that moves a parsed decimal
 * between scales without ever touching a binary float.
 *
 * @throws {DecimalError} when `scale` is not a non-negative integer.
 */
export function decimalScaleFactor(scale: number): bigint {
  if (!Number.isInteger(scale) || scale < 0) {
    throw new DecimalError("Decimal scale must be a non-negative integer.");
  }
  return 10n ** BigInt(scale);
}

/**
 * Format integer units at a fixed scale back to a decimal string. Negative
 * units keep the sign in front of the whole part.
 *
 * @throws {DecimalError} when `scale` is not a non-negative integer.
 */
export function formatDecimal(units: bigint, scale: number): string {
  if (!Number.isInteger(scale) || scale < 0) {
    throw new DecimalError("Decimal scale must be a non-negative integer.");
  }
  if (scale === 0) return units.toString();
  const negative = units < 0n;
  // Pad the magnitude: padding a "-5" string would emit "0.000000-5".
  const digits = (negative ? -units : units).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, -scale);
  const fraction = digits.slice(-scale);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/**
 * Ceiling division — rounds UP on any remainder, so a payer is never quoted
 * less than the amount owed. Assumes a NON-NEGATIVE numerator, which every
 * caller passes: `(n + d - 1n) / d` is a ceiling toward +∞, so a negative
 * numerator would round toward zero instead.
 *
 * @throws {DecimalError} when `denominator` is not greater than zero.
 */
export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new DecimalError("Division denominator must be greater than zero.");
  }
  return (numerator + denominator - 1n) / denominator;
}

/** Format whole satoshis as a BTC decimal, trimming trailing zeros. */
export function formatBtcFromSats(sats: bigint): string {
  return formatDecimal(sats, 8).replace(/0+$/, "").replace(/\.$/, "");
}

export function isBitcoinAmountCurrency(currency: string): currency is BitcoinAmount["currency"] {
  return currency === "BTC" || currency === "SAT" || currency === "SATS";
}

/**
 * Whole satoshis for a BTC/SAT/SATS amount.
 *
 * @throws {DecimalError} when the value is not a non-negative
 * decimal, is finer than one satoshi, or is a fractional satoshi count.
 */
export function bitcoinAmountToSats(amount: BitcoinAmount): bigint {
  const parsed = parseDecimal(amount.value, "amount.value");
  const scale = decimalScaleFactor(parsed.scale);

  if (amount.currency === "BTC") {
    const numerator = parsed.units * OPENRECEIVE_SATS_PER_BTC;
    if (numerator % scale !== 0n) {
      throw new DecimalError("BTC amount cannot be more precise than satoshis.");
    }
    return numerator / scale;
  }

  if (parsed.units % scale !== 0n) {
    throw new DecimalError("SATS amount must be a whole number of satoshis.");
  }
  return parsed.units / scale;
}

/**
 * Multiply a money amount by a whole quantity.
 *
 * @throws {DecimalError} for a negative/non-integer quantity or a
 * malformed amount.
 */
export function multiplyAmount(amount: MoneyAmount, quantity: number): MoneyAmount {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new DecimalError("Quantity must be a non-negative integer.");
  }
  const decimal = parseDecimal(amount.value);
  return {
    currency: amount.currency,
    value: formatDecimal(decimal.units * BigInt(quantity), decimal.scale),
  };
}

/**
 * Total amounts that share one currency, at the widest scale present.
 *
 * @throws {DecimalError} when the list is empty, mixes currencies,
 * or carries a malformed value.
 */
export function sumAmounts(amounts: readonly MoneyAmount[]): MoneyAmount {
  const first = amounts[0];
  if (first === undefined) {
    throw new DecimalError("At least one amount is required to total.");
  }
  const currency = first.currency;
  let scale = 0;
  let totalUnits = 0n;

  for (const amount of amounts) {
    if (amount.currency !== currency) {
      throw new DecimalError("Amounts must use one currency.");
    }
    const decimal = parseDecimal(amount.value);
    if (decimal.scale > scale) {
      totalUnits *= decimalScaleFactor(decimal.scale - scale);
      scale = decimal.scale;
    }
    totalUnits += decimal.units * decimalScaleFactor(scale - decimal.scale);
  }

  return {
    currency,
    value: formatDecimal(totalUnits, scale),
  };
}

/** Shared copy for "the feed cannot price this currency", used by every rate lookup. */
export function formatMissingBtcFiatRateMessage(currency: string, source?: string): string {
  const from = source === undefined ? "the price feed" : source;
  return `rate for ${currency.toUpperCase()} not available from ${from}`;
}

/**
 * Require a BTC/<currency> price from a rate map (keys are lowercase ISO codes).
 *
 * @throws {PriceFeedError} when the map has no rate for the currency.
 */
export function requiredBtcFiatRate(rates: BtcFiatRateMap | undefined, currency: string): string {
  const rate = rates?.bitcoin[currency.toLowerCase()];
  if (rate === undefined) {
    throw new PriceFeedError(formatMissingBtcFiatRateMessage(currency));
  }
  return rate;
}

/**
 * Parse a BTC/fiat price (units of fiat per 1 BTC) from feed data.
 *
 * @throws {PriceFeedError} when the price is malformed or not
 * greater than zero. Never a `RangeError`: a bad price is a feed outage.
 */
export function parseBtcFiatPrice(btcFiatPrice: string): Decimal {
  if (!DECIMAL_PATTERN.test(btcFiatPrice)) {
    throw new PriceFeedError("BTC fiat price must be a non-negative decimal string.");
  }
  const price = parseDecimal(btcFiatPrice);
  if (price.units <= 0n) {
    throw new PriceFeedError("BTC fiat price must be greater than zero.");
  }
  return price;
}

/**
 * Convert a fiat value to whole satoshis using a BTC/fiat price
 * (units of fiat per 1 BTC). Rounds up to the next whole satoshi.
 *
 * @throws {DecimalError} when `fiatValue` is malformed.
 * @throws {PriceFeedError} when `btcFiatPrice` is unusable.
 */
export function fiatValueToSats(fiatValue: string, btcFiatPrice: string): bigint {
  const fiat = parseDecimal(fiatValue, "fiat.value");
  const price = parseBtcFiatPrice(btcFiatPrice);
  const numerator = fiat.units * decimalScaleFactor(price.scale) * OPENRECEIVE_SATS_PER_BTC;
  const denominator = price.units * decimalScaleFactor(fiat.scale);
  return ceilDiv(numerator, denominator);
}

/**
 * Reverse of {@link fiatValueToSats}: whole satoshis → fiat decimal string
 * using a BTC/fiat price (units of fiat per 1 BTC).
 *
 * @throws {DecimalError} for negative sats or a bad output scale.
 * @throws {PriceFeedError} when `btcFiatPrice` is unusable.
 */
export function satsToFiatValue(sats: bigint, btcFiatPrice: string, outputScale = 2): string {
  if (sats < 0n) {
    throw new DecimalError("Satoshis must be non-negative.");
  }
  const price = parseBtcFiatPrice(btcFiatPrice);
  const scaleFactor = decimalScaleFactor(outputScale);
  const numerator = sats * price.units * scaleFactor;
  const denominator = OPENRECEIVE_SATS_PER_BTC * decimalScaleFactor(price.scale);
  return formatDecimal(ceilDiv(numerator, denominator), outputScale);
}

/**
 * Convert a value between two fiat currencies that both have BTC prices
 * (units of fiat per 1 BTC). Used for USD→EUR style display conversion.
 *
 * @throws {DecimalError} for a malformed value or output scale.
 * @throws {PriceFeedError} when either price is unusable.
 */
export function convertFiatViaBtcPrices(
  value: string,
  fromBtcPrice: string,
  toBtcPrice: string,
  outputScale = 2,
): string {
  const amount = parseDecimal(value);
  const fromPrice = parseBtcFiatPrice(fromBtcPrice);
  const toPrice = parseBtcFiatPrice(toBtcPrice);
  const scaleFactor = decimalScaleFactor(outputScale);

  const numerator =
    amount.units * toPrice.units * decimalScaleFactor(fromPrice.scale) * scaleFactor;
  const denominator =
    decimalScaleFactor(amount.scale) * decimalScaleFactor(toPrice.scale) * fromPrice.units;
  return formatDecimal(ceilDiv(numerator, denominator), outputScale);
}

/**
 * Convert an amount into a target currency using BTC price rates. Handles both
 * directions across the BTC bridge — fiat→fiat, fiat→BTC/SATS, and
 * BTC/SATS→fiat — plus BTC↔SATS, which needs no rate at all. Currency codes
 * compare case-insensitively, matching the lowercase rate-map lookup.
 *
 * @throws {DecimalError} when the amount is malformed.
 * @throws {PriceFeedError} when a rate the conversion needs is
 * missing or unusable.
 */
export function convertAmountViaBtcRates(
  amount: MoneyAmount,
  targetCurrency: string,
  rates: BtcFiatRateMap | undefined,
  options: { readonly outputScale?: number } = {},
): MoneyAmount {
  const from = amount.currency.toUpperCase();
  const target = targetCurrency.toUpperCase();
  if (from === target) return amount;

  const outputScale = options.outputScale ?? 2;
  const fromBitcoin = isBitcoinAmountCurrency(from);
  const targetBitcoin = isBitcoinAmountCurrency(target);

  if (fromBitcoin) {
    const sats = bitcoinAmountToSats({ currency: from, value: amount.value });
    if (targetBitcoin) return bitcoinAmount(targetCurrency, target, sats);
    return {
      currency: targetCurrency,
      value: satsToFiatValue(sats, requiredBtcFiatRate(rates, target), outputScale),
    };
  }

  const fromRate = requiredBtcFiatRate(rates, from);
  if (targetBitcoin) {
    return bitcoinAmount(targetCurrency, target, fiatValueToSats(amount.value, fromRate));
  }

  return {
    currency: targetCurrency,
    value: convertFiatViaBtcPrices(
      amount.value,
      fromRate,
      requiredBtcFiatRate(rates, target),
      outputScale,
    ),
  };
}

function bitcoinAmount(currency: string, normalizedCurrency: string, sats: bigint): MoneyAmount {
  return {
    currency,
    value: normalizedCurrency === "BTC" ? formatBtcFromSats(sats) : sats.toString(),
  };
}
