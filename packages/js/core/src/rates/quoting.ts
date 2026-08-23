/**
 * Fiat and bitcoin amount quoting. Pure math over a caller-supplied BTC price —
 * nothing here fetches, caches, or decides which feed to trust.
 */

import {
  bitcoinAmountToSats,
  fiatValueToSats,
  OPENRECEIVE_MSATS_PER_SAT,
  type BitcoinAmount,
  type BtcFiatRateMap,
  DecimalError,
} from "../money/decimal.ts";
import { unixSeconds } from "../values.ts";
import {
  OPENRECEIVE_INVOICE_QUOTE_TTL_SECONDS,
  OPENRECEIVE_MAX_AMOUNT_MSATS,
  OPENRECEIVE_MAX_AMOUNT_SATS,
  OPENRECEIVE_MIN_AMOUNT_MSATS,
  OPENRECEIVE_MIN_AMOUNT_SATS,
  OPENRECEIVE_STATIC_BTC_FIAT_RATES,
  OPENRECEIVE_STATIC_PRICE_SOURCE_ID,
} from "./constants.ts";
import { isFiatCurrencyCode, normalizeFiatCurrency } from "./parsing.ts";
import type {
  DirectAmountQuote,
  RateQuote,
  SourcedPriceProvider,
  QuoteFiatToMsatsRequest,
  QuoteFiatToMsatsWithPriceRequest,
} from "./types.ts";

function toSafeJsonInteger(value: bigint, fieldName: string): number {
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);

  if (value > maximum) {
    throw new DecimalError(`${fieldName} exceeds JSON safe integer boundary`);
  }

  return Number(value);
}

function normalizeUnixSeconds(value: number, fieldName: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DecimalError(`${fieldName} must be a non-negative safe integer`);
  }

  return value;
}

function assertAmountBounds(amountSats: bigint, amountMsats: bigint): void {
  if (amountSats < OPENRECEIVE_MIN_AMOUNT_SATS) {
    throw new DecimalError("amount_sats must be at least 1");
  }

  if (amountSats > OPENRECEIVE_MAX_AMOUNT_SATS) {
    throw new DecimalError("amount_sats exceeds JSON safe integer boundary");
  }

  if (amountMsats < OPENRECEIVE_MIN_AMOUNT_MSATS) {
    throw new DecimalError("amount_msats must be at least 1000");
  }

  if (amountMsats > OPENRECEIVE_MAX_AMOUNT_MSATS) {
    throw new DecimalError("amount_msats exceeds JSON safe integer boundary");
  }
}

/**
 * Convert a BTC/SAT/SATS amount straight to msats — no price feed involved.
 *
 * @throws {DecimalError} for a malformed, sub-satoshi, or
 * out-of-range amount.
 */
export function quoteBitcoinAmountToMsats(amount: BitcoinAmount): DirectAmountQuote {
  const amountSats = bitcoinAmountToSats(amount);
  const amountMsats = amountSats * OPENRECEIVE_MSATS_PER_SAT;

  assertAmountBounds(amountSats, amountMsats);

  return {
    amountSats: toSafeJsonInteger(amountSats, "amount_sats"),
    amountMsats: toSafeJsonInteger(amountMsats, "amount_msats"),
  };
}

/**
 * The fixed BTC price used by {@link StaticPriceProvider} and
 * {@link quoteFiatToMsatsAtMockRate}. Not a market rate — tests, docs, and
 * screenshots only.
 *
 * @throws {DecimalError} for a currency the static table lacks.
 */
export function getStaticBtcFiatPrice(currency: string): string {
  const rateKey = normalizeFiatCurrency(
    currency,
  ) as keyof typeof OPENRECEIVE_STATIC_BTC_FIAT_RATES.bitcoin;
  const rate = OPENRECEIVE_STATIC_BTC_FIAT_RATES.bitcoin[rateKey];

  if (rate === undefined) {
    throw new DecimalError(`unsupported static fiat currency: ${currency}`);
  }

  return rate;
}

/**
 * Quote a fiat amount at a caller-supplied BTC price, rounding up to a whole
 * satoshi.
 *
 * @throws {DecimalError} for malformed fiat input or an
 * out-of-range result.
 * @throws {PriceFeedError} when `btcFiatPrice` is unusable.
 */
export function quoteFiatToMsatsWithPrice(request: QuoteFiatToMsatsWithPriceRequest): RateQuote {
  if (request.fiat === undefined) {
    throw new DecimalError("fiat is required");
  }

  const fiat = request.fiat;
  if (!isFiatCurrencyCode(fiat.currency)) {
    throw new DecimalError("fiat.currency must be an ISO 4217 uppercase code");
  }

  const btcFiatPrice = request.btcFiatPrice;
  const amountSats = fiatValueToSats(fiat.value, btcFiatPrice);
  const amountMsats = amountSats * OPENRECEIVE_MSATS_PER_SAT;

  assertAmountBounds(amountSats, amountMsats);

  const asOf = normalizeUnixSeconds(request.asOf ?? unixSeconds(), "as_of");
  const ttlSeconds = normalizeUnixSeconds(
    request.ttlSeconds ?? OPENRECEIVE_INVOICE_QUOTE_TTL_SECONDS,
    "ttl_seconds",
  );
  const expiresAt = normalizeUnixSeconds(asOf + ttlSeconds, "expires_at");

  return {
    fiat: {
      currency: fiat.currency,
      value: fiat.value,
    },
    btcFiatPrice,
    amountSats: toSafeJsonInteger(amountSats, "amount_sats"),
    amountMsats: toSafeJsonInteger(amountMsats, "amount_msats"),
    source: request.source,
    asOf,
    expiresAt,
  };
}

/**
 * Quote at the hard-coded static rate — a deterministic fixture, NOT a market
 * price. Never use it to price a real invoice: the quote is marked
 * `source: "static_mock"` precisely so a caller cannot mistake it for one.
 *
 * @throws {DecimalError} for a currency the static table lacks.
 */
export function quoteFiatToMsatsAtMockRate(request: QuoteFiatToMsatsRequest): RateQuote {
  return quoteFiatToMsatsWithPrice({
    ...request,
    btcFiatPrice: getStaticBtcFiatPrice(request.fiat.currency),
    source: OPENRECEIVE_STATIC_PRICE_SOURCE_ID,
  });
}

/** Offline/test provider serving {@link OPENRECEIVE_STATIC_BTC_FIAT_RATES}. */
export class StaticPriceProvider implements SourcedPriceProvider {
  readonly source = OPENRECEIVE_STATIC_PRICE_SOURCE_ID;

  async getBtcFiatRates(currencies: readonly string[]): Promise<BtcFiatRateMap> {
    const rates: Record<string, string> = {};

    for (const currency of currencies) {
      const rateKey = normalizeFiatCurrency(currency);
      rates[rateKey] = getStaticBtcFiatPrice(currency);
    }

    return {
      bitcoin: rates,
    };
  }
}
