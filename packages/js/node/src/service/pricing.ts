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
  type OpenReceivePriceFeedCacheStore,
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
import type {
  ListRatesRequest,
  OpenReceiveServiceContext,
  ResolvedCreateAmount,
} from "./types.ts";

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
    const rates = await getBtcFiatRatesForProviders({
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
      as_of: context.clock(),
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
  return normalizeOpenReceivePriceCurrencies(rawCurrencies, "openreceive.yml price currencies");
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
      hint: "Set OPENRECEIVE_PRICE_CURRENCIES in openreceive.yml to fiat codes like USD and EUR, or omit it to use USD.",
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
        amount_msats: quote.amount_msats,
        amount_source: "amount",
        fiat_quote: null,
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
      as_of: input.now,
      priceProviders: input.priceProviders,
    });
    return {
      amount_msats: quote.amount_msats,
      amount_source: "fiat",
      fiat_quote: quote,
    };
  } catch (error) {
    if (error instanceof OpenReceiveServiceError) throw error;
    throw mapPriceError(error);
  }
}

export async function quoteFiatAmount(input: {
  fiat: OpenReceiveFiatAmount;
  as_of: number;
  priceProviders: readonly OpenReceiveSourcedPriceProvider[];
}): Promise<OpenReceiveRateQuote> {
  const rates = await getBtcFiatRatesForProviders({
    currencies: [input.fiat.currency],
    priceProviders: input.priceProviders,
  });
  const btcFiatPrice = rates.rates.bitcoin[input.fiat.currency.toLowerCase()];

  if (btcFiatPrice === undefined) {
    throw new RangeError(`price provider ${rates.source} did not return ${input.fiat.currency}`);
  }

  return quoteFiatToMsatsWithPrice({
    fiat: input.fiat,
    btc_fiat_price: btcFiatPrice,
    source: rates.source,
    as_of: input.as_of,
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

// Builds the database-cached live price feed (primary first, fallback second),
// honoring the OPENRECEIVE_PRICE_FEED_PRIMARY_URL / _FALLBACK_URL dev overrides.
// Pass the same OpenReceive store the service uses so the 60s cache is durable.
export function createOpenReceivePriceFeed(options: {
  store: OpenReceivePriceFeedCacheStore;
  currencies: readonly string[];
  fetch?: SimplePriceFetch;
  clock?: () => number;
  cacheSeconds?: number;
}): CachedPriceFeed {
  const overrides = readPriceFeedUrlOverrides();
  return createCachedLivePriceFeed({
    store: options.store,
    currencies: options.currencies,
    fetch: options.fetch,
    clock: options.clock,
    cacheSeconds: options.cacheSeconds,
    primaryUrl: overrides.primaryUrl,
    fallbackUrl: overrides.fallbackUrl,
  });
}

export function readPriceFeedUrlOverrides(): {
  primaryUrl: string | undefined;
  fallbackUrl: string | undefined;
} {
  return {
    primaryUrl: readPriceFeedUrlEnv(OPENRECEIVE_PRICE_FEED_PRIMARY_URL_ENV),
    fallbackUrl: readPriceFeedUrlEnv(OPENRECEIVE_PRICE_FEED_FALLBACK_URL_ENV),
  };
}

export function readPriceFeedUrlEnv(name: string): string | undefined {
  const value = globalThis.process?.env?.[name];
  if (value === undefined || value.trim().length === 0) return undefined;
  return value.trim();
}

export function mapPriceError(error: unknown): OpenReceiveServiceError {
  if (error instanceof OpenReceiveServiceError) return error;
  if (error instanceof RangeError) {
    return serviceError(400, "INVALID_REQUEST", error.message);
  }

  return serviceError(503, "INTERNAL", "Unable to fetch BTC fiat exchange rate.");
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
