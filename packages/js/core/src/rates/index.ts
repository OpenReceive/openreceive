type MaybePromise<T> = T | Promise<T>;

interface MetaRow {
  readonly key: string;
  readonly value: string;
  readonly rev: number;
}

// How long a cached price-feed read stays usable before a live refresh.
export const OPENRECEIVE_PRICE_FEED_CACHE_SECONDS = 60 as const;
export const OPENRECEIVE_INVOICE_QUOTE_TTL_SECONDS = 600 as const;

// The primary feed must answer within this window before the fallback is tried.
export const OPENRECEIVE_PRICE_FEED_PRIMARY_TIMEOUT_MS = 5000 as const;

export const OPENRECEIVE_PRICE_SOURCE_IDS = [
  "static_mock",
  "primary",
  "fallback"
] as const;

export type OpenReceivePriceSourceId = (typeof OPENRECEIVE_PRICE_SOURCE_IDS)[number];

export type OpenReceiveLivePriceSourceId = Exclude<OpenReceivePriceSourceId, "static_mock">;

const OPENRECEIVE_STATIC_PRICE_SOURCE_ID = "static_mock" as const;

export const OPENRECEIVE_STATIC_BTC_FIAT_RATES = {
  bitcoin: {
    usd: "50000.00"
  }
} as const;

// The fixed fiat list both live feeds price Bitcoin against. Hard-coded so the
// primary and fallback URLs always request the same currencies.
export const OPENRECEIVE_PRICE_FEED_VS_CURRENCIES =
  "usd,aed,ars,aud,bdt,bhd,bmd,brl,cad,chf,clp,cny,czk,dkk,eur,gbp,gel,hkd,huf,idr,ils,inr,jpy,krw,kwd,lkr,mmk,mxn,myr,ngn,nok,nzd,php,pkr,pln,rub,sar,sek,sgd,thb,try,twd,uah,vef,vnd,zar" as const;

export const OPENRECEIVE_SIMPLE_PRICE_BASE_URL =
  "https://api.coingecko.com/api/v3/simple/price" as const;

// Primary live feed: the canonical public Simple Price endpoint.
export const OPENRECEIVE_PRIMARY_PRICE_FEED_URL =
  `${OPENRECEIVE_SIMPLE_PRICE_BASE_URL}?ids=bitcoin&vs_currencies=${OPENRECEIVE_PRICE_FEED_VS_CURRENCIES}` as const;

// Fallback live feed: the OpenReceive mirror, in the same response shape.
export const OPENRECEIVE_FALLBACK_PRICE_FEED_URL =
  `https://openreceive.org/api/v3/simple/price?ids=bitcoin&vs_currencies=${OPENRECEIVE_PRICE_FEED_VS_CURRENCIES}` as const;

// Dev override env var names. The node service reads these and passes any
// override through to the feed; core never reads the environment itself.
export const OPENRECEIVE_PRICE_FEED_PRIMARY_URL_ENV =
  "OPENRECEIVE_PRICE_FEED_PRIMARY_URL" as const;
export const OPENRECEIVE_PRICE_FEED_FALLBACK_URL_ENV =
  "OPENRECEIVE_PRICE_FEED_FALLBACK_URL" as const;

// Process-local key used by the disposable quote cache.
const OPENRECEIVE_PRICE_FEED_CACHE_META_KEY = "price_feed:bitcoin" as const;

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

export interface SimplePriceHttpResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type SimplePriceFetch = (
  url: string,
  init?: {
    headers?: Record<string, string>;
    signal?: AbortSignal;
  }
) => Promise<SimplePriceHttpResponse>;

export interface HttpSimplePriceProviderOptions {
  url: string;
  source: OpenReceiveLivePriceSourceId;
  fetch?: SimplePriceFetch;
  timeoutMs?: number;
}

// A price provider that can also report which source actually answered, so a
// cached or multi-URL feed can attribute each rate to its real origin.
export interface OpenReceiveResolvedPriceProvider extends OpenReceiveSourcedPriceProvider {
  getBtcFiatRatesWithSource(
    currencies: readonly string[]
  ): Promise<OpenReceiveBtcFiatRateMapWithSource>;
}

// A live feed that can be probed explicitly to confirm it answers correctly.
export interface OpenReceivePriceFeedHealthCheck {
  healthCheck(
    currencies?: readonly string[]
  ): Promise<OpenReceiveBtcFiatRateMapWithSource>;
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

export function createSimplePriceUrl(
  currencies: readonly string[],
  baseUrl = OPENRECEIVE_SIMPLE_PRICE_BASE_URL
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

export function parseSimplePriceResponse(
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

// Tolerant parse for caching the whole feed: keeps every well-formed currency
// the response carries and skips ones an upstream returned unusably (so a single
// dropped currency never fails the refresh). Throws only when the response is
// not Simple Price shaped or carries no usable rate at all.
export function parseAvailableSimplePriceResponse(
  response: unknown
): OpenReceiveBtcFiatRateMap {
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
    throw new RangeError("price response contained no usable BTC fiat rates");
  }

  return {
    bitcoin: rates
  };
}

// Fetches a Simple Price compatible HTTP endpoint and selects the requested
// fiat currencies. When timeoutMs is set, a slow endpoint is aborted so the
// caller can fall through to another feed.
export class HttpSimplePriceProvider implements OpenReceiveSourcedPriceProvider {
  readonly url: string;
  readonly source: OpenReceiveLivePriceSourceId;
  readonly timeoutMs?: number;
  #fetch: SimplePriceFetch;

  constructor(options: HttpSimplePriceProviderOptions) {
    this.url = options.url;
    this.source = options.source;
    this.timeoutMs = options.timeoutMs;
    this.#fetch = options.fetch ?? (globalThis.fetch as unknown as SimplePriceFetch);
  }

  async getBtcFiatRates(currencies: readonly string[]): Promise<OpenReceiveBtcFiatRateMap> {
    return parseSimplePriceResponse(await this.#fetchJson(), currencies);
  }

  // Returns every well-formed currency the endpoint carries, for caching the
  // whole feed in one read.
  async getAllBtcFiatRates(): Promise<OpenReceiveBtcFiatRateMap> {
    return parseAvailableSimplePriceResponse(await this.#fetchJson());
  }

  async #fetchJson(): Promise<unknown> {
    const response = await this.#fetchWithTimeout();

    if (!response.ok) {
      throw new Error(`price source ${this.source} returned HTTP ${response.status}`);
    }

    return JSON.parse(await response.text());
  }

  async #fetchWithTimeout(): Promise<SimplePriceHttpResponse> {
    const headers = { accept: "application/json" };
    if (this.timeoutMs === undefined) {
      return this.#fetch(this.url, { headers });
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new Error(`price source ${this.source} did not respond within ${this.timeoutMs}ms`)
        );
      }, this.timeoutMs);
    });

    try {
      return await Promise.race([
        this.#fetch(this.url, { headers, signal: controller.signal }),
        timeout
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

export interface OpenReceiveLivePriceFeedProviders {
  readonly primary: HttpSimplePriceProvider;
  readonly fallback: HttpSimplePriceProvider;
}

// Builds the primary and fallback live feed providers from the hard-coded URLs
// (or caller overrides). The primary provider carries the 5s timeout.
export function createLivePriceFeedProviders(options: {
  fetch?: SimplePriceFetch;
  primaryUrl?: string;
  fallbackUrl?: string;
  primaryTimeoutMs?: number;
} = {}): OpenReceiveLivePriceFeedProviders {
  return {
    primary: new HttpSimplePriceProvider({
      url: options.primaryUrl ?? OPENRECEIVE_PRIMARY_PRICE_FEED_URL,
      source: "primary",
      fetch: options.fetch,
      timeoutMs: options.primaryTimeoutMs ?? OPENRECEIVE_PRICE_FEED_PRIMARY_TIMEOUT_MS
    }),
    fallback: new HttpSimplePriceProvider({
      url: options.fallbackUrl ?? OPENRECEIVE_FALLBACK_PRICE_FEED_URL,
      source: "fallback",
      fetch: options.fetch
    })
  };
}

// Process-local cache surface. This is intentionally not injectable: price
// caching is disposable and OpenReceive has no storage configuration.
interface OpenReceivePriceFeedCacheMap {
  getMeta(key: string): MaybePromise<MetaRow | undefined>;
  casMeta(
    key: string,
    value: string,
    expectedRev: number | null
  ): MaybePromise<{ status: "ok" | "conflict"; row: MetaRow }>;
}

interface PriceFeedCacheEntry {
  rates: OpenReceiveBtcFiatRateMap;
  source: OpenReceiveLivePriceSourceId;
  fetched_at: number;
}

interface PriceFeedCacheState {
  entry?: PriceFeedCacheEntry;
  refresh_started_at?: number;
  refresh_failed_at?: number;
  refresh_error?: string;
}

type PriceFeedRefreshClaim =
  | {
      status: "claimed";
      row: MetaRow;
      previousEntry?: PriceFeedCacheEntry;
    }
  | {
      status: "served";
      entry: PriceFeedCacheEntry;
    };

export interface CachedPriceFeedOptions {
  currencies: readonly string[];
  primary: OpenReceiveSourcedPriceProvider;
  fallback: OpenReceiveSourcedPriceProvider;
  cacheSeconds?: number;
  clock?: () => number;
}

// Serves BTC fiat rates from a disposable process-local cache, refreshing from
// the primary feed first and the fallback second.
export class CachedPriceFeed
  implements OpenReceiveResolvedPriceProvider, OpenReceivePriceFeedHealthCheck
{
  // Representative source for the bare OpenReceiveSourcedPriceProvider view;
  // the true origin is reported per-call by getBtcFiatRatesWithSource.
  readonly source: OpenReceiveLivePriceSourceId = "primary";
  readonly #cache: OpenReceivePriceFeedCacheMap;
  readonly #currencies: readonly string[];
  readonly #primary: OpenReceiveSourcedPriceProvider;
  readonly #fallback: OpenReceiveSourcedPriceProvider;
  readonly #cacheSeconds: number;
  readonly #cacheKey: string;
  readonly #clock: () => number;

  constructor(options: CachedPriceFeedOptions) {
    if (options.currencies.length === 0) {
      throw new RangeError("CachedPriceFeed requires at least one currency");
    }
    this.#cache = createTransientPriceFeedCache();
    this.#currencies = [...options.currencies];
    this.#primary = options.primary;
    this.#fallback = options.fallback;
    this.#cacheSeconds = options.cacheSeconds ?? OPENRECEIVE_PRICE_FEED_CACHE_SECONDS;
    this.#cacheKey = OPENRECEIVE_PRICE_FEED_CACHE_META_KEY;
    this.#clock = options.clock ?? currentUnixSeconds;
  }

  async getBtcFiatRates(currencies: readonly string[]): Promise<OpenReceiveBtcFiatRateMap> {
    return (await this.getBtcFiatRatesWithSource(currencies)).rates;
  }

  async getBtcFiatRatesWithSource(
    currencies: readonly string[]
  ): Promise<OpenReceiveBtcFiatRateMapWithSource> {
    const now = this.#clock();
    const claimed = await this.#readOrClaimRefresh(now);
    const resolved =
      claimed.status === "served"
        ? claimed.entry
        : await this.#refresh(now, claimed.row.rev, claimed.previousEntry);
    return {
      source: resolved.source,
      rates: parseSimplePriceResponse(resolved.rates, currencies)
    };
  }

  // Forces a live refresh, ignoring the cache, for explicit operational probes.
  // Throws if both feeds fail. Tolerant of an upstream that drops an individual
  // currency.
  async healthCheck(): Promise<OpenReceiveBtcFiatRateMapWithSource> {
    const now = this.#clock();
    const meta = await this.#cache.getMeta(this.#cacheKey);
    const previousEntry = parsePriceFeedCacheState(meta?.value)?.entry;
    const resolved = await this.#refresh(
      now,
      meta === undefined ? null : meta.rev,
      previousEntry
    );
    return {
      source: resolved.source,
      rates: resolved.rates
    };
  }

  async #readOrClaimRefresh(now: number): Promise<PriceFeedRefreshClaim> {
    let meta = await this.#cache.getMeta(this.#cacheKey);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const state = parsePriceFeedCacheState(meta?.value);
      const freshEntry = this.#freshEntry(state, now);
      if (freshEntry !== undefined) {
        return {
          status: "served",
          entry: freshEntry
        };
      }

      if (this.#isRecent(state?.refresh_failed_at, now)) {
        throw new Error(
          `price feed refresh already failed within ${this.#cacheSeconds}s${
            state?.refresh_error === undefined ? "" : `: ${state.refresh_error}`
          }`
        );
      }

      if (this.#isRecent(state?.refresh_started_at, now)) {
        if (state?.entry !== undefined) {
          return {
            status: "served",
            entry: state.entry
          };
        }
        throw new Error(
          `price feed refresh already started within ${this.#cacheSeconds}s`
        );
      }

      const claim = await this.#cache.casMeta(
        this.#cacheKey,
        serializePriceFeedCacheState({
          entry: state?.entry,
          refresh_started_at: now
        }),
        meta === undefined ? null : meta.rev
      );

      if (claim.status === "ok") {
        return {
          status: "claimed",
          row: claim.row,
          previousEntry: state?.entry
        };
      }

      meta = claim.row.rev < 0 ? undefined : claim.row;
    }

    throw new Error("price feed cache changed too often while claiming refresh");
  }

  #freshEntry(
    state: PriceFeedCacheState | undefined,
    now: number
  ): PriceFeedCacheEntry | undefined {
    if (state?.entry === undefined) return undefined;
    if (now - state.entry.fetched_at >= this.#cacheSeconds) return undefined;
    return state.entry;
  }

  #isRecent(timestamp: number | undefined, now: number): boolean {
    return timestamp !== undefined && now - timestamp < this.#cacheSeconds;
  }

  async #refresh(
    now: number,
    expectedRev: number | null,
    previousEntry: PriceFeedCacheEntry | undefined
  ): Promise<PriceFeedCacheEntry> {
    const failures: string[] = [];
    for (const provider of [this.#primary, this.#fallback]) {
      try {
        const rates = await this.#fetchProviderRates(provider);
        const source = provider.source as OpenReceiveLivePriceSourceId;
        const entry: PriceFeedCacheEntry = { rates, source, fetched_at: now };
        await this.#writeCacheState({ entry }, expectedRev);
        return entry;
      } catch (error) {
        failures.push(
          `${provider.source}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    const error = new Error(`all price feeds failed: ${failures.join("; ")}`);
    await this.#writeCacheState(
      {
        entry: previousEntry,
        refresh_started_at: now,
        refresh_failed_at: now,
        refresh_error: error.message
      },
      expectedRev
    );
    throw error;
  }

  // Cache the whole feed when the provider can serve it tolerantly; otherwise
  // request just the configured currencies.
  #fetchProviderRates(
    provider: OpenReceiveSourcedPriceProvider
  ): Promise<OpenReceiveBtcFiatRateMap> {
    if (providerHasGetAllBtcFiatRates(provider)) {
      return provider.getAllBtcFiatRates();
    }
    return provider.getBtcFiatRates(this.#currencies);
  }

  async #writeCacheState(
    state: PriceFeedCacheState,
    expectedRev: number | null
  ): Promise<void> {
    // A concurrent writer winning the CAS is fine; later callers observe it.
    await this.#cache.casMeta(
      this.#cacheKey,
      serializePriceFeedCacheState(state),
      expectedRev
    );
  }
}

interface AvailableRatesProvider {
  getAllBtcFiatRates(): Promise<OpenReceiveBtcFiatRateMap>;
}

function providerHasGetAllBtcFiatRates(
  provider: OpenReceiveSourcedPriceProvider
): provider is OpenReceiveSourcedPriceProvider & AvailableRatesProvider {
  return (
    typeof (provider as Partial<AvailableRatesProvider>).getAllBtcFiatRates === "function"
  );
}

function parsePriceFeedCacheState(value: string | undefined): PriceFeedCacheState | undefined {
  if (value === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }

  if (parsed === null || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  const entry = parsePriceFeedCacheEntry(record);
  const refreshStartedAt = optionalCacheTimestamp(record.refresh_started_at);
  const refreshFailedAt = optionalCacheTimestamp(record.refresh_failed_at);
  const refreshError =
    typeof record.refresh_error === "string" && record.refresh_error.length > 0
      ? record.refresh_error
      : undefined;

  if (
    entry === undefined &&
    refreshStartedAt === undefined &&
    refreshFailedAt === undefined
  ) {
    return undefined;
  }

  return {
    ...(entry === undefined ? {} : { entry }),
    ...(refreshStartedAt === undefined ? {} : { refresh_started_at: refreshStartedAt }),
    ...(refreshFailedAt === undefined ? {} : { refresh_failed_at: refreshFailedAt }),
    ...(refreshError === undefined ? {} : { refresh_error: refreshError })
  };
}

function parsePriceFeedCacheEntry(
  record: Record<string, unknown>
): PriceFeedCacheEntry | undefined {
  const fetchedAt = record.fetched_at;
  const source = record.source;
  const rates = record.rates;

  if (
    !isCacheTimestamp(fetchedAt) ||
    (source !== "primary" && source !== "fallback") ||
    rates === null ||
    typeof rates !== "object" ||
    typeof (rates as { bitcoin?: unknown }).bitcoin !== "object" ||
    (rates as { bitcoin?: unknown }).bitcoin === null
  ) {
    return undefined;
  }

  return {
    rates: rates as OpenReceiveBtcFiatRateMap,
    source,
    fetched_at: fetchedAt as number
  };
}

function serializePriceFeedCacheState(state: PriceFeedCacheState): string {
  return JSON.stringify({
    ...(state.entry === undefined
      ? {}
      : {
          rates: state.entry.rates,
          source: state.entry.source,
          fetched_at: state.entry.fetched_at
        }),
    ...(state.refresh_started_at === undefined
      ? {}
      : { refresh_started_at: state.refresh_started_at }),
    ...(state.refresh_failed_at === undefined
      ? {}
      : { refresh_failed_at: state.refresh_failed_at }),
    ...(state.refresh_error === undefined ? {} : { refresh_error: state.refresh_error })
  });
}

function optionalCacheTimestamp(value: unknown): number | undefined {
  return isCacheTimestamp(value) ? value : undefined;
}

function isCacheTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

// Wires the hard-coded (or overridden) feeds to a disposable local cache.
export function createCachedLivePriceFeed(options: {
  currencies: readonly string[];
  fetch?: SimplePriceFetch;
  clock?: () => number;
  cacheSeconds?: number;
  primaryUrl?: string;
  fallbackUrl?: string;
  primaryTimeoutMs?: number;
}): CachedPriceFeed {
  const { primary, fallback } = createLivePriceFeedProviders({
    fetch: options.fetch,
    primaryUrl: options.primaryUrl,
    fallbackUrl: options.fallbackUrl,
    primaryTimeoutMs: options.primaryTimeoutMs
  });

  return new CachedPriceFeed({
    currencies: options.currencies,
    primary,
    fallback,
    cacheSeconds: options.cacheSeconds,
    clock: options.clock
  });
}

function createTransientPriceFeedCache(): OpenReceivePriceFeedCacheMap {
  let row: MetaRow | undefined;
  return {
    getMeta(key) {
      return row?.key === key ? structuredClone(row) : undefined;
    },
    casMeta(key, value, expectedRev) {
      const actualRev = row?.key === key ? row.rev : null;
      if (actualRev !== expectedRev) {
        return {
          status: "conflict",
          row: structuredClone(row ?? { key, value: "", rev: -1 }),
        };
      }
      row = { key, value, rev: (actualRev ?? 0) + 1 };
      return { status: "ok", row: structuredClone(row) };
    },
  };
}

export function isResolvedPriceProvider(
  provider: OpenReceiveSourcedPriceProvider
): provider is OpenReceiveResolvedPriceProvider {
  return (
    typeof (provider as Partial<OpenReceiveResolvedPriceProvider>)
      .getBtcFiatRatesWithSource === "function"
  );
}

export function isHealthCheckablePriceFeed(
  provider: OpenReceiveSourcedPriceProvider
): provider is OpenReceiveSourcedPriceProvider & OpenReceivePriceFeedHealthCheck {
  return (
    typeof (provider as Partial<OpenReceivePriceFeedHealthCheck>).healthCheck === "function"
  );
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
      if (isResolvedPriceProvider(provider)) {
        return await provider.getBtcFiatRatesWithSource(input.currencies);
      }
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
