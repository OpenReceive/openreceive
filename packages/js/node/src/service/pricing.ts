import {
  type CachedPriceFeed,
  createCachedLivePriceFeed,
  getBtcFiatRatesWithFallback,
  isResolvedPriceProvider,
  OPENRECEIVE_PRICE_FEED_FALLBACK_URL_ENV,
  OPENRECEIVE_PRICE_FEED_PRIMARY_URL_ENV,
  type OpenReceiveBitcoinAmount,
  type OpenReceiveBtcFiatRateMapWithSource,
  type OpenReceiveFiatAmount,
  type OpenReceiveRateQuote,
  type OpenReceiveSourcedPriceProvider,
  quoteBitcoinAmountToMsats,
  quoteFiatToMsatsWithPrice,
  type SimplePriceFetch,
} from "@openreceive/core";
import { OpenReceiveConfigError } from "../config-error.ts";
import {
  asRecord,
  OpenReceiveServiceError,
  optionalString,
  parseOptionalRecord,
  serviceError,
} from "./core-utils.ts";
import type { ListRatesRequest, OpenReceiveServiceContext, ResolvedCreateAmount } from "./types.ts";

export async function listRates(
  context: OpenReceiveServiceContext,
  input: ListRatesRequest = {},
): Promise<OpenReceiveBtcFiatRateMapWithSource["rates"]> {
  try {
    const currencies =
      input.currencies === undefined
        ? context.priceCurrencies
        : normalizeOpenReceivePriceCurrencies(input.currencies, "listRates currencies");
    for (const currency of currencies) {
      assertAllowedFiatCurrency(currency, context.priceCurrencies);
    }
    const rates = await fetchRatesOrUnavailable({
      currencies,
      priceProviders: context.priceProviders,
    });
    return rates.rates;
  } catch (error) {
    throw mapPriceError(error);
  }
}

export async function quoteRates(
  context: OpenReceiveServiceContext,
  input: { readonly fiat: OpenReceiveFiatAmount },
): Promise<OpenReceiveRateQuote> {
  const body = asRecord(input);
  try {
    const fiat = parseFiatAmount(body.fiat);
    assertAllowedFiatCurrency(fiat.currency, context.priceCurrencies);
    return await quoteFiatAmount({
      fiat,
      asOf: context.clock(),
      priceProviders: context.priceProviders,
    });
  } catch (error) {
    throw mapPriceError(error);
  }
}

export function readOpenReceivePriceCurrencies(
  configured: readonly string[] | undefined,
): readonly string[] {
  const rawCurrencies = configured ?? ["USD"];
  return normalizeOpenReceivePriceCurrencies(rawCurrencies, "OpenReceive price currencies");
}

export function normalizeOpenReceivePriceCurrencies(
  rawCurrencies: readonly string[],
  label: string,
): readonly string[] {
  const currencies = [
    ...new Set(rawCurrencies.map((currency) => currency.trim().toUpperCase()).filter(Boolean)),
  ];
  if (currencies.length === 0) {
    throw new OpenReceiveConfigError({
      code: "INVALID_PRICE_CURRENCIES",
      message: `${label} must include at least one currency.`,
      hint: "Set priceCurrencies to fiat codes like USD and EUR, or omit it to use USD.",
    });
  }
  for (const currency of currencies) {
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new OpenReceiveConfigError({
        code: "INVALID_PRICE_CURRENCIES",
        message: `Invalid ${label} entry: ${currency}.`,
        hint: "Use three-letter fiat currency codes such as USD or EUR.",
      });
    }
  }
  return currencies;
}

export async function resolveCreateAmount(input: {
  body: Record<string, unknown>;
  now: number;
  priceProviders: readonly OpenReceiveSourcedPriceProvider[];
  priceCurrencies: readonly string[];
}): Promise<ResolvedCreateAmount> {
  const { body } = input;
  const hasAmount = body.amount !== undefined;
  const hasFiat = body.fiat !== undefined;
  const sourceCount = [hasAmount, hasFiat].filter(Boolean).length;

  if (sourceCount !== 1) {
    throw serviceError(
      400,
      "INVALID_REQUEST",
      "Create checkout request requires exactly one of amount or fiat.",
    );
  }

  if (hasAmount) {
    try {
      const quote = quoteBitcoinAmountToMsats(parseBitcoinAmount(body.amount));
      return {
        amountMsats: quote.amountMsats,
        amountSource: "amount",
        fiatQuote: null,
      };
    } catch (error) {
      if (error instanceof OpenReceiveServiceError) throw error;
      throw mapPriceError(error);
    }
  }

  try {
    const fiat = parseFiatAmount(body.fiat);
    assertAllowedFiatCurrency(fiat.currency, input.priceCurrencies);
    const quote = await quoteFiatAmount({
      fiat,
      asOf: input.now,
      priceProviders: input.priceProviders,
    });
    return {
      amountMsats: quote.amountMsats,
      amountSource: "fiat",
      fiatQuote: quote,
    };
  } catch (error) {
    if (error instanceof OpenReceiveServiceError) throw error;
    throw mapPriceError(error);
  }
}

export async function quoteFiatAmount(input: {
  fiat: OpenReceiveFiatAmount;
  asOf: number;
  priceProviders: readonly OpenReceiveSourcedPriceProvider[];
}): Promise<OpenReceiveRateQuote> {
  const rates = await fetchRatesOrUnavailable({
    currencies: [input.fiat.currency],
    priceProviders: input.priceProviders,
  });
  const btcFiatPrice = rates.rates.bitcoin[input.fiat.currency.toLowerCase()];

  if (btcFiatPrice === undefined) {
    // A provider gap is a feed outage, never the payer's fault: retryable 503,
    // same as every other rates-unavailable path.
    throw ratesUnavailableError(
      `price provider ${rates.source} did not return ${input.fiat.currency}`,
    );
  }

  return quoteFiatToMsatsWithPrice({
    fiat: input.fiat,
    btcFiatPrice,
    source: rates.source,
    asOf: input.asOf,
  });
}

export function assertAllowedFiatCurrency(
  currency: string,
  allowedCurrencies: readonly string[],
): void {
  if (!allowedCurrencies.includes(currency)) {
    throw serviceError(
      400,
      "INVALID_REQUEST",
      `fiat.currency must be one of the configured priceCurrencies: ${allowedCurrencies.join(", ")}.`,
    );
  }
}

/**
 * Fetch rates, mapping EVERY feed-side failure (network, HTTP, malformed or
 * incomplete response) to the payer-facing retryable 503 — the feed being
 * unable to price a configured currency is an outage, never payer input.
 */
async function fetchRatesOrUnavailable(input: {
  currencies: readonly string[];
  priceProviders: readonly OpenReceiveSourcedPriceProvider[];
}): Promise<OpenReceiveBtcFiatRateMapWithSource> {
  try {
    return await getBtcFiatRatesForProviders(input);
  } catch (error) {
    if (error instanceof OpenReceiveServiceError) throw error;
    throw ratesUnavailableError(error instanceof Error ? error.message : undefined);
  }
}

export async function getBtcFiatRatesForProviders(input: {
  currencies: readonly string[];
  priceProviders: readonly OpenReceiveSourcedPriceProvider[];
}): Promise<OpenReceiveBtcFiatRateMapWithSource> {
  if (input.priceProviders.length === 1) {
    const [provider] = input.priceProviders;
    if (isResolvedPriceProvider(provider)) {
      return await provider.getBtcFiatRatesWithSource(input.currencies);
    }
    return {
      source: provider.source,
      rates: await provider.getBtcFiatRates(input.currencies),
    };
  }

  return getBtcFiatRatesWithFallback({
    currencies: input.currencies,
    providers: input.priceProviders,
  });
}

// Builds the live price feed with a process-local TTL cache. This cache is an
// optimization only: no payment truth or workflow state depends on it.
export function createOpenReceivePriceFeed(options: {
  currencies: readonly string[];
  fetch?: SimplePriceFetch;
  clock?: () => number;
  cacheSeconds?: number;
  /** Environment for the URL override vars. Defaults to process.env. */
  env?: Readonly<Record<string, string | undefined>>;
}): CachedPriceFeed {
  const overrides = readPriceFeedUrlOverrides(options.env);
  return createCachedLivePriceFeed({
    currencies: options.currencies,
    fetch: options.fetch,
    clock: options.clock,
    cacheSeconds: options.cacheSeconds,
    primaryUrl: overrides.primaryUrl,
    fallbackUrl: overrides.fallbackUrl,
  });
}

export function readPriceFeedUrlOverrides(env?: Readonly<Record<string, string | undefined>>): {
  primaryUrl: string | undefined;
  fallbackUrl: string | undefined;
} {
  return {
    primaryUrl: readPriceFeedUrlEnv(OPENRECEIVE_PRICE_FEED_PRIMARY_URL_ENV, env),
    fallbackUrl: readPriceFeedUrlEnv(OPENRECEIVE_PRICE_FEED_FALLBACK_URL_ENV, env),
  };
}

export function readPriceFeedUrlEnv(
  name: string,
  env: Readonly<Record<string, string | undefined>> | undefined = globalThis.process?.env,
): string | undefined {
  const value = env?.[name];
  if (value === undefined || value.trim().length === 0) return undefined;
  return value.trim();
}

/**
 * Payer-facing, retryable refusal used whenever fiat rates cannot be served
 * from a sufficiently recent observation. Invoices are never minted from a
 * mock or stale rate — the fail-closed alternative to silent mispricing.
 */
export function ratesUnavailableError(internalDetail?: string): OpenReceiveServiceError {
  const error = serviceError(
    503,
    "INTERNAL",
    "Exchange rates are temporarily unavailable — please try again in a moment.",
    { retryable: true },
  );
  if (internalDetail !== undefined) error.cause = new Error(internalDetail);
  return error;
}

export function mapPriceError(error: unknown): OpenReceiveServiceError {
  if (error instanceof OpenReceiveServiceError) return error;
  // RangeErrors from quote math are genuine input validation (bad decimal,
  // out-of-range amount) and stay 400; feed failures arrive as plain Errors.
  if (error instanceof RangeError) {
    return serviceError(400, "INVALID_REQUEST", error.message);
  }

  return ratesUnavailableError(error instanceof Error ? error.message : undefined);
}

export function parseFiatAmount(value: unknown): OpenReceiveFiatAmount {
  const record = parseOptionalRecord(value, "fiat");
  if (record === undefined) {
    throw serviceError(400, "INVALID_REQUEST", "fiat must be a JSON object.");
  }
  const currency = optionalString(record.currency);
  const amountValue = optionalString(record.value);
  if (currency === undefined || !/^[A-Z]{3}$/.test(currency)) {
    throw serviceError(400, "INVALID_REQUEST", "fiat.currency must be an ISO 4217 uppercase code");
  }
  if (amountValue === undefined) {
    throw serviceError(400, "INVALID_REQUEST", "fiat.value must be a decimal string");
  }
  return {
    currency,
    value: amountValue,
  };
}

export function parseBitcoinAmount(value: unknown): OpenReceiveBitcoinAmount {
  const record = parseOptionalRecord(value, "amount");
  if (record === undefined) {
    throw serviceError(400, "INVALID_REQUEST", "amount must be a JSON object.");
  }
  const currency = optionalString(record.currency);
  const amountValue = optionalString(record.value);
  if (currency === undefined || !["BTC", "SAT", "SATS"].includes(currency)) {
    throw serviceError(
      400,
      "INVALID_REQUEST",
      "amount.currency must be BTC, SAT, or SATS. Use fiat for price-feed currencies.",
    );
  }
  if (amountValue === undefined) {
    throw serviceError(400, "INVALID_REQUEST", "amount.value must be a decimal string");
  }
  return {
    currency: currency as OpenReceiveBitcoinAmount["currency"],
    value: amountValue,
  };
}
