/** Fixed rate-quoting policy. None of these are host knobs. */

// How long a cached price-feed read stays usable before a live refresh.
export const OPENRECEIVE_PRICE_FEED_CACHE_SECONDS = 60 as const;
export const OPENRECEIVE_INVOICE_QUOTE_TTL_SECONDS = 600 as const;

// The primary feed must answer within this window before the fallback is tried.
export const OPENRECEIVE_PRICE_FEED_PRIMARY_TIMEOUT_MS = 5000 as const;
// The fallback needs its own ceiling: without one a black-holed connection
// stalls every fiat quote for the platform fetch default (minutes).
export const OPENRECEIVE_PRICE_FEED_FALLBACK_TIMEOUT_MS = 10_000 as const;

/**
 * Tolerance for a wall-clock that steps backwards. A cache entry stamped in the
 * future is not "fresh forever" — beyond this much skew it reads as stale and
 * forces a refresh.
 */
export const OPENRECEIVE_PRICE_FEED_CLOCK_SKEW_SECONDS = 5 as const;

export const OPENRECEIVE_STATIC_PRICE_SOURCE_ID = "static_mock" as const;

export const OPENRECEIVE_STATIC_BTC_FIAT_RATES = {
  bitcoin: {
    usd: "50000.00",
  },
} as const;

// The fixed fiat list both live feeds price Bitcoin against. Hard-coded so the
// primary and fallback URLs always request the same currencies.
export const OPENRECEIVE_PRICE_FEED_VS_CURRENCIES =
  "usd,aed,ars,aud,bdt,bhd,bmd,brl,cad,chf,clp,cny,czk,dkk,eur,gbp,gel,hkd,huf,idr,ils,inr,jpy,krw,kwd,lkr,mmk,mxn,myr,ngn,nok,nzd,php,pkr,pln,rub,sar,sek,sgd,thb,try,twd,uah,vef,vnd,zar" as const;

const OPENRECEIVE_SIMPLE_PRICE_BASE_URL = "https://api.coingecko.com/api/v3/simple/price" as const;

// Primary live feed: the canonical public Simple Price endpoint.
export const OPENRECEIVE_PRIMARY_PRICE_FEED_URL =
  `${OPENRECEIVE_SIMPLE_PRICE_BASE_URL}?ids=bitcoin&vs_currencies=${OPENRECEIVE_PRICE_FEED_VS_CURRENCIES}` as const;

// Fallback live feed: the OpenReceive mirror, in the same response shape.
export const OPENRECEIVE_FALLBACK_PRICE_FEED_URL =
  `https://openreceive.org/api/v3/simple/price?ids=bitcoin&vs_currencies=${OPENRECEIVE_PRICE_FEED_VS_CURRENCIES}` as const;

// Dev override env var names. The node service reads these and passes any
// override through to the feed; core never reads the environment itself.
export const OPENRECEIVE_PRICE_FEED_PRIMARY_URL_ENV = "OPENRECEIVE_PRICE_FEED_PRIMARY_URL" as const;
export const OPENRECEIVE_PRICE_FEED_FALLBACK_URL_ENV =
  "OPENRECEIVE_PRICE_FEED_FALLBACK_URL" as const;

export const OPENRECEIVE_MIN_AMOUNT_SATS = 1n;
export const OPENRECEIVE_MAX_AMOUNT_SATS = 9_007_199_254_740n;
export const OPENRECEIVE_MIN_AMOUNT_MSATS = 1000n;
export const OPENRECEIVE_MAX_AMOUNT_MSATS = 9_007_199_254_740_991n;
