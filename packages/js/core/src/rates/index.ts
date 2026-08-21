/**
 * Rate quoting and price feeds, split by concern:
 * - `constants.ts` — the fixed quoting policy (TTLs, timeouts, feed URLs).
 * - `types.ts` — provider/quote shapes and the provider capability guards.
 * - `parsing.ts` — Simple Price response interpretation (no network).
 * - `quoting.ts` — amount math over a caller-supplied BTC price.
 * - `http.ts` — the HTTP transport for Simple Price endpoints.
 * - `cache.ts` — the disposable process-local cache and provider fallback.
 *
 * This barrel is the package-internal surface `../index.ts` re-exports.
 */

export {
  CachedPriceFeed,
  type CachedPriceFeedOptions,
  createCachedLivePriceFeed,
  getBtcFiatRatesWithFallback,
} from "./cache.ts";
export {
  OPENRECEIVE_FALLBACK_PRICE_FEED_URL,
  OPENRECEIVE_INVOICE_QUOTE_TTL_SECONDS,
  OPENRECEIVE_MAX_AMOUNT_MSATS,
  OPENRECEIVE_MIN_AMOUNT_MSATS,
  OPENRECEIVE_PRICE_FEED_CACHE_SECONDS,
  OPENRECEIVE_PRICE_FEED_FALLBACK_TIMEOUT_MS,
  OPENRECEIVE_PRICE_FEED_FALLBACK_URL_ENV,
  OPENRECEIVE_PRICE_FEED_PRIMARY_TIMEOUT_MS,
  OPENRECEIVE_PRICE_FEED_PRIMARY_URL_ENV,
  OPENRECEIVE_PRICE_FEED_VS_CURRENCIES,
  OPENRECEIVE_PRIMARY_PRICE_FEED_URL,
  OPENRECEIVE_STATIC_BTC_FIAT_RATES,
} from "./constants.ts";
export {
  quoteBitcoinAmountToMsats,
  quoteFiatToMsatsWithPrice,
  StaticPriceProvider,
} from "./quoting.ts";
export {
  isResolvedPriceProvider,
  type OpenReceiveBtcFiatRateMapWithSource,
  type OpenReceiveDirectAmountQuote,
  type OpenReceiveLivePriceSourceId,
  type OpenReceivePriceFeedHealthCheck,
  type OpenReceivePriceSourceId,
  type OpenReceiveRateQuote,
  type OpenReceiveResolvedPriceProvider,
  type OpenReceiveSourcedPriceProvider,
  type QuoteFiatToMsatsRequest,
  type QuoteFiatToMsatsWithPriceRequest,
  type SimplePriceFetch,
} from "./types.ts";
