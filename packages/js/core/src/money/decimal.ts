/**
 * Exact integer/decimal money math for OpenReceive hosts.
 *
 * Uses bigint only — never binary floats. Public surface for cart totals,
 * display conversion via BTC rates, and sats ↔ fiat bridges.
 */

export class OpenReceiveDecimalError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "OpenReceiveDecimalError";
    this.status = status;
  }
}

export interface OpenReceiveDecimal {
  readonly units: bigint;
  readonly scale: number;
}

export interface OpenReceiveMoneyAmount {
  readonly currency: string;
  readonly value: string;
}

export interface OpenReceiveBtcPriceRates {
  readonly bitcoin: Readonly<Record<string, string>>;
}

/** Parse a non-negative decimal string into integer units + scale. */
export function parseDecimal(value: string): OpenReceiveDecimal {
  if (!/^\d+(?:\.\d+)?$/.test(value)) {
    throw new OpenReceiveDecimalError("Amounts must be non-negative decimal strings.");
  }
  const [integer, fraction = ""] = value.split(".");
  return {
    units: BigInt(`${integer}${fraction}`),
    scale: fraction.length,
  };
}

/** Format integer units at a fixed scale back to a decimal string. */
export function formatDecimal(units: bigint, scale: number): string {
  if (scale === 0) return units.toString();
  const raw = units.toString().padStart(scale + 1, "0");
  const whole = raw.slice(0, -scale);
  const fraction = raw.slice(-scale);
  return `${whole}.${fraction}`;
}

export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new OpenReceiveDecimalError("Division denominator must be greater than zero.", 500);
  }
  return (numerator + denominator - 1n) / denominator;
}

/** Format whole satoshis as a BTC decimal, trimming trailing zeros. */
export function formatBtcFromSats(sats: bigint): string {
  return formatDecimal(sats, 8).replace(/0+$/, "").replace(/\.$/, "");
}

export function multiplyAmount(
  amount: OpenReceiveMoneyAmount,
  quantity: number,
): OpenReceiveMoneyAmount {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new OpenReceiveDecimalError("Quantity must be a non-negative integer.");
  }
  const decimal = parseDecimal(amount.value);
  return {
    currency: amount.currency,
    value: formatDecimal(decimal.units * BigInt(quantity), decimal.scale),
  };
}

export function sumAmounts(amounts: readonly OpenReceiveMoneyAmount[]): OpenReceiveMoneyAmount {
  const first = amounts[0];
  if (first === undefined) {
    throw new OpenReceiveDecimalError("At least one amount is required to total.");
  }
  const currency = first.currency;
  let scale = 0;
  let totalUnits = 0n;

  for (const amount of amounts) {
    if (amount.currency !== currency) {
      throw new OpenReceiveDecimalError("Amounts must use one currency.");
    }
    const decimal = parseDecimal(amount.value);
    if (decimal.scale > scale) {
      totalUnits *= 10n ** BigInt(decimal.scale - scale);
      scale = decimal.scale;
    }
    totalUnits += decimal.units * 10n ** BigInt(scale - decimal.scale);
  }

  return {
    currency,
    value: formatDecimal(totalUnits, scale),
  };
}

/** Require a BTC/<currency> price from a rate map (keys are lowercase ISO codes). */
export function requiredBtcFiatRate(
  rates: OpenReceiveBtcPriceRates | undefined,
  currency: string,
): string {
  const rate = rates?.bitcoin[currency.toLowerCase()];
  if (rate === undefined) {
    throw new OpenReceiveDecimalError(`Missing BTC/${currency} price feed rate.`, 503);
  }
  return rate;
}

/**
 * Convert a fiat value to whole satoshis using a BTC/fiat price
 * (units of fiat per 1 BTC).
 */
export function fiatValueToSats(fiatValue: string, btcFiatPrice: string): bigint {
  const fiat = parseDecimal(fiatValue);
  const price = parseDecimal(btcFiatPrice);
  if (price.units <= 0n) {
    throw new OpenReceiveDecimalError("BTC fiat price must be greater than zero.", 503);
  }
  const numerator = fiat.units * 10n ** BigInt(price.scale) * 100_000_000n;
  const denominator = price.units * 10n ** BigInt(fiat.scale);
  return ceilDiv(numerator, denominator);
}

/**
 * Reverse of {@link fiatValueToSats}: whole satoshis → fiat decimal string
 * using a BTC/fiat price (units of fiat per 1 BTC).
 */
export function satsToFiatValue(
  sats: bigint,
  btcFiatPrice: string,
  outputScale = 2,
): string {
  if (sats < 0n) {
    throw new OpenReceiveDecimalError("Satoshis must be non-negative.");
  }
  if (!Number.isInteger(outputScale) || outputScale < 0) {
    throw new OpenReceiveDecimalError("outputScale must be a non-negative integer.");
  }
  const price = parseDecimal(btcFiatPrice);
  if (price.units <= 0n) {
    throw new OpenReceiveDecimalError("BTC fiat price must be greater than zero.", 503);
  }
  const scaleFactor = 10n ** BigInt(outputScale);
  const numerator = sats * price.units * scaleFactor;
  const denominator = 100_000_000n * 10n ** BigInt(price.scale);
  return formatDecimal(ceilDiv(numerator, denominator), outputScale);
}

/**
 * Convert a value between two fiat currencies that both have BTC prices
 * (units of fiat per 1 BTC). Used for USD→EUR style display conversion.
 */
export function convertFiatViaBtcPrices(
  value: string,
  fromBtcPrice: string,
  toBtcPrice: string,
  outputScale = 2,
): string {
  const amount = parseDecimal(value);
  const fromPrice = parseDecimal(fromBtcPrice);
  const toPrice = parseDecimal(toBtcPrice);
  if (fromPrice.units <= 0n || toPrice.units <= 0n) {
    throw new OpenReceiveDecimalError("BTC fiat price feed rates must be greater than zero.", 503);
  }
  if (!Number.isInteger(outputScale) || outputScale < 0) {
    throw new OpenReceiveDecimalError("outputScale must be a non-negative integer.");
  }

  const scaleFactor = 10n ** BigInt(outputScale);
  const numerator =
    amount.units * toPrice.units * 10n ** BigInt(fromPrice.scale) * scaleFactor;
  const denominator =
    10n ** BigInt(amount.scale) * 10n ** BigInt(toPrice.scale) * fromPrice.units;
  return formatDecimal(ceilDiv(numerator, denominator), outputScale);
}

/**
 * Convert an amount into a target currency using BTC price rates.
 * Supports BTC/SATS targets and cross-fiat conversion via the BTC bridge.
 * Caller supplies the base-currency policy (e.g. catalog is USD).
 */
export function convertAmountViaBtcRates(
  amount: OpenReceiveMoneyAmount,
  targetCurrency: string,
  rates: OpenReceiveBtcPriceRates | undefined,
  options: { readonly outputScale?: number } = {},
): OpenReceiveMoneyAmount {
  if (targetCurrency === amount.currency) return amount;

  const fromRate = requiredBtcFiatRate(rates, amount.currency);
  if (targetCurrency === "BTC" || targetCurrency === "SATS") {
    const sats = fiatValueToSats(amount.value, fromRate);
    return {
      currency: targetCurrency,
      value: targetCurrency === "BTC" ? formatBtcFromSats(sats) : sats.toString(),
    };
  }

  const toRate = requiredBtcFiatRate(rates, targetCurrency);
  return {
    currency: targetCurrency,
    value: convertFiatViaBtcPrices(amount.value, fromRate, toRate, options.outputScale ?? 2),
  };
}
