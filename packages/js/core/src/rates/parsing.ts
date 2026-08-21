/**
 * Simple Price response parsing. Pure functions over already-fetched data, so
 * every accept/reject rule here is testable without a network.
 */

import {
  formatMissingBtcFiatRateMessage,
  type OpenReceiveBtcFiatRateMap,
  OpenReceiveDecimalError,
  OpenReceivePriceFeedError,
  parseDecimal,
} from "../money/decimal.ts";

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * @throws {OpenReceiveDecimalError} when the code is not an uppercase ISO 4217
 * currency — that is caller input, not feed data.
 */
export function normalizeFiatCurrency(currency: string): string {
  if (!CURRENCY_PATTERN.test(currency)) {
    throw new OpenReceiveDecimalError("fiat.currency must be an ISO 4217 uppercase code");
  }

  return currency.toLowerCase();
}

export function isFiatCurrencyCode(currency: string): boolean {
  return CURRENCY_PATTERN.test(currency);
}

/**
 * Select the requested currencies out of a Simple Price response (or a cached
 * rate map).
 *
 * @throws {OpenReceivePriceFeedError} when the response is not Simple Price
 * shaped, or lacks a usable rate for a requested currency.
 */
export function parseSimplePriceResponse(
  response: unknown,
  currencies: readonly string[],
  source?: string,
): OpenReceiveBtcFiatRateMap {
  const bitcoin = asRecord(asRecord(response).bitcoin);
  const rates: Record<string, string> = {};

  for (const currency of currencies) {
    const rateKey = normalizeFiatCurrency(currency);
    const rawRate = bitcoin[rateKey];
    if (rawRate === undefined) {
      throw new OpenReceivePriceFeedError(formatMissingBtcFiatRateMessage(currency, source));
    }
    rates[rateKey] = normalizeBtcFiatRate(rawRate, `bitcoin.${rateKey}`);
  }

  return {
    bitcoin: rates,
  };
}

/**
 * Tolerant parse for caching the whole feed: keeps every well-formed currency
 * the response carries and skips ones an upstream returned unusably (so a single
 * dropped currency never fails the refresh).
 *
 * @throws {OpenReceivePriceFeedError} when the response is not Simple Price
 * shaped or carries no usable rate at all.
 */
export function parseAvailableSimplePriceResponse(response: unknown): OpenReceiveBtcFiatRateMap {
  const bitcoin = asRecord(asRecord(response).bitcoin);
  const rates: Record<string, string> = {};

  for (const [key, value] of Object.entries(bitcoin)) {
    if (!/^[a-z]{3}$/.test(key.toLowerCase())) continue;
    try {
      rates[key.toLowerCase()] = normalizeBtcFiatRate(value, `bitcoin.${key}`);
    } catch {
      // Skip a currency the upstream returned in an unusable form.
    }
  }

  if (Object.keys(rates).length === 0) {
    throw new OpenReceivePriceFeedError("price response contained no usable BTC fiat rates");
  }

  return {
    bitcoin: rates,
  };
}

function normalizeBtcFiatRate(value: unknown, fieldName: string): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) {
      throw new OpenReceivePriceFeedError(`${fieldName} must be a positive number`);
    }
    return assertPositiveFeedDecimal(numberToPlainDecimalString(value), fieldName);
  }

  if (typeof value === "string") {
    return assertPositiveFeedDecimal(value, fieldName);
  }

  throw new OpenReceivePriceFeedError(`${fieldName} must be a number or decimal string`);
}

function assertPositiveFeedDecimal(value: string, fieldName: string): string {
  let units: bigint;
  try {
    units = parseDecimal(value, fieldName).units;
  } catch {
    // Feed data, not caller input: never surface it as a payer-side RangeError.
    throw new OpenReceivePriceFeedError(`${fieldName} must be a non-negative decimal string`);
  }
  if (units <= 0n) {
    throw new OpenReceivePriceFeedError(`${fieldName} must be greater than 0`);
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new OpenReceivePriceFeedError("price response is not Simple Price shaped");
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
