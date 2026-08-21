/**
 * Disposable process-local rate cache plus the fallback chain across providers.
 *
 * Two bounds hold on every read path, whatever the cache says:
 * - a rate observed longer ago than {@link OPENRECEIVE_INVOICE_QUOTE_TTL_SECONDS}
 *   never prices anything, and
 * - one caller at a time fetches; the rest either take a still-valid entry or
 *   await that same fetch, so a cold start cannot stampede the upstream or fail
 *   every concurrent checkout but one.
 */

import { type OpenReceiveBtcFiatRateMap, OpenReceivePriceFeedError } from "../money/decimal.ts";
import {
  OPENRECEIVE_INVOICE_QUOTE_TTL_SECONDS,
  OPENRECEIVE_PRICE_FEED_CACHE_META_KEY,
  OPENRECEIVE_PRICE_FEED_CACHE_SECONDS,
  OPENRECEIVE_PRICE_FEED_CLOCK_SKEW_SECONDS,
} from "./constants.ts";
import { createLivePriceFeedProviders } from "./http.ts";
import { parseSimplePriceResponse } from "./parsing.ts";
import { currentUnixSeconds } from "./quoting.ts";
import {
  isResolvedPriceProvider,
  type OpenReceiveBtcFiatRateMapWithSource,
  type OpenReceiveLivePriceSourceId,
  type OpenReceivePriceFeedHealthCheck,
  type OpenReceiveResolvedPriceProvider,
  type OpenReceiveSourcedPriceProvider,
  providerHasGetAllBtcFiatRates,
  type SimplePriceFetch,
} from "./types.ts";

type MaybePromise<T> = T | Promise<T>;

interface MetaRow {
  readonly key: string;
  readonly value: string;
  readonly rev: number;
}

// Process-local cache surface. This is intentionally not injectable: price
// caching is disposable and OpenReceive has no storage configuration.
interface OpenReceivePriceFeedCacheMap {
  getMeta(key: string): MaybePromise<MetaRow | undefined>;
  casMeta(
    key: string,
    value: string,
    expectedRev: number | null,
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
      status: "served";
      entry: PriceFeedCacheEntry;
    }
  | {
      status: "pending";
      pending: Promise<PriceFeedCacheEntry>;
    };

export interface CachedPriceFeedOptions {
  currencies: readonly string[];
  primary: OpenReceiveSourcedPriceProvider;
  fallback: OpenReceiveSourcedPriceProvider;
  cacheSeconds?: number;
  clock?: () => number;
}

/**
 * Serves BTC fiat rates from a disposable process-local cache, refreshing from
 * the primary feed first and the fallback second.
 */
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
  #inFlight?: Promise<PriceFeedCacheEntry>;

  constructor(options: CachedPriceFeedOptions) {
    // Construction failures are host misconfiguration (a boot bug), never payer
    // input: throw TypeError — matching the Ruby port's constructor validation —
    // not the 400-mapped OpenReceiveDecimalError.
    if (options.currencies.length === 0) {
      throw new TypeError("CachedPriceFeed requires at least one currency");
    }
    const cacheSeconds = options.cacheSeconds ?? OPENRECEIVE_PRICE_FEED_CACHE_SECONDS;
    if (!Number.isSafeInteger(cacheSeconds) || cacheSeconds <= 0) {
      throw new TypeError("CachedPriceFeed cacheSeconds must be a positive integer");
    }
    // A cache window wider than the quote TTL would let a read be reported as
    // fresh that is already too old to price an invoice.
    if (cacheSeconds > OPENRECEIVE_INVOICE_QUOTE_TTL_SECONDS) {
      throw new TypeError(
        `CachedPriceFeed cacheSeconds must not exceed the ${OPENRECEIVE_INVOICE_QUOTE_TTL_SECONDS}s invoice quote TTL`,
      );
    }
    this.#cache = createTransientPriceFeedCache();
    this.#currencies = [...options.currencies];
    this.#primary = options.primary;
    this.#fallback = options.fallback;
    this.#cacheSeconds = cacheSeconds;
    this.#cacheKey = OPENRECEIVE_PRICE_FEED_CACHE_META_KEY;
    this.#clock = options.clock ?? currentUnixSeconds;
  }

  async getBtcFiatRates(currencies: readonly string[]): Promise<OpenReceiveBtcFiatRateMap> {
    return (await this.getBtcFiatRatesWithSource(currencies)).rates;
  }

  /**
   * @throws {OpenReceivePriceFeedError} when no rate recent enough to price a
   * quote can be served — always retryable, never payer input.
   */
  async getBtcFiatRatesWithSource(
    currencies: readonly string[],
  ): Promise<OpenReceiveBtcFiatRateMapWithSource> {
    const now = this.#clock();
    const claimed = await this.#readOrClaimRefresh(now);
    const resolved = claimed.status === "served" ? claimed.entry : await claimed.pending;
    return {
      source: resolved.source,
      rates: parseSimplePriceResponse(resolved.rates, currencies, resolved.source),
    };
  }

  // Forces a live refresh, ignoring the cache, for explicit operational probes.
  // Throws if both feeds fail. Tolerant of an upstream that drops an individual
  // currency.
  async healthCheck(currencies?: readonly string[]): Promise<OpenReceiveBtcFiatRateMapWithSource> {
    const now = this.#clock();
    const meta = await this.#cache.getMeta(this.#cacheKey);
    const previousEntry = parsePriceFeedCacheState(meta?.value)?.entry;
    const resolved = await this.#trackedRefresh(
      now,
      meta === undefined ? null : meta.rev,
      previousEntry,
    );
    return {
      source: resolved.source,
      rates:
        currencies === undefined || currencies.length === 0
          ? resolved.rates
          : parseSimplePriceResponse(resolved.rates, currencies, resolved.source),
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
          entry: freshEntry,
        };
      }

      // Stale-while-revalidate is bounded by the invoice quote TTL: a rate
      // observed longer ago than a quote may live must never price a new
      // invoice — fail closed instead of serving it.
      const usableEntry = this.#quotableEntry(state, now);

      if (this.#isRecent(state?.refresh_failed_at, now)) {
        // One failed refresh must not hard-down quoting for the whole backoff
        // while a still-quotable observation is in hand.
        if (usableEntry !== undefined) {
          return { status: "served", entry: usableEntry };
        }
        throw new OpenReceivePriceFeedError(
          `price feed refresh already failed within ${this.#cacheSeconds}s${
            state?.refresh_error === undefined ? "" : `: ${state.refresh_error}`
          }`,
        );
      }

      if (this.#isRecent(state?.refresh_started_at, now)) {
        if (usableEntry !== undefined) {
          return { status: "served", entry: usableEntry };
        }
        // Cold cache: join the refresh already running in this process rather
        // than failing every concurrent caller but the one that claimed it.
        const pending = this.#inFlight;
        if (pending !== undefined) {
          return { status: "pending", pending };
        }
        throw new OpenReceivePriceFeedError(
          `price feed refresh already started within ${this.#cacheSeconds}s`,
        );
      }

      const claim = await this.#cache.casMeta(
        this.#cacheKey,
        serializePriceFeedCacheState({
          entry: state?.entry,
          refresh_started_at: now,
        }),
        meta === undefined ? null : meta.rev,
      );

      if (claim.status === "ok") {
        // Publish the in-flight promise in the same tick the claim lands, so a
        // caller that observes refresh_started_at always finds it to join.
        return {
          status: "pending",
          pending: this.#trackedRefresh(now, claim.row.rev, state?.entry),
        };
      }

      meta = claim.row.rev < 0 ? undefined : claim.row;
    }

    throw new OpenReceivePriceFeedError(
      "price feed cache changed too often while claiming refresh",
    );
  }

  /**
   * Age of a cache stamp, or `undefined` when the stamp is unusable. A stamp
   * in the future beyond the skew tolerance means the clock stepped backwards:
   * treat it as stale rather than "fresh until wall-clock catches up".
   */
  #stampAge(timestamp: number | undefined, now: number): number | undefined {
    if (timestamp === undefined) return undefined;
    const age = now - timestamp;
    if (age < -OPENRECEIVE_PRICE_FEED_CLOCK_SKEW_SECONDS) return undefined;
    return age < 0 ? 0 : age;
  }

  #freshEntry(
    state: PriceFeedCacheState | undefined,
    now: number,
  ): PriceFeedCacheEntry | undefined {
    if (state?.entry === undefined) return undefined;
    const age = this.#stampAge(state.entry.fetched_at, now);
    if (age === undefined || age >= this.#cacheSeconds) return undefined;
    return state.entry;
  }

  /** A cached entry still young enough to price a quote from, if any. */
  #quotableEntry(
    state: PriceFeedCacheState | undefined,
    now: number,
  ): PriceFeedCacheEntry | undefined {
    if (state?.entry === undefined) return undefined;
    const age = this.#stampAge(state.entry.fetched_at, now);
    if (age === undefined || age >= OPENRECEIVE_INVOICE_QUOTE_TTL_SECONDS) return undefined;
    return state.entry;
  }

  #isRecent(timestamp: number | undefined, now: number): boolean {
    const age = this.#stampAge(timestamp, now);
    return age !== undefined && age < this.#cacheSeconds;
  }

  #trackedRefresh(
    now: number,
    expectedRev: number | null,
    previousEntry: PriceFeedCacheEntry | undefined,
  ): Promise<PriceFeedCacheEntry> {
    const pending = this.#refresh(now, expectedRev, previousEntry);
    this.#inFlight = pending;
    const clear = () => {
      if (this.#inFlight === pending) this.#inFlight = undefined;
    };
    pending.then(clear, clear);
    return pending;
  }

  async #refresh(
    now: number,
    expectedRev: number | null,
    previousEntry: PriceFeedCacheEntry | undefined,
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
          `${provider.source}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const error = new OpenReceivePriceFeedError(`all price feeds failed: ${failures.join("; ")}`);
    await this.#writeCacheState(
      {
        entry: previousEntry,
        refresh_started_at: now,
        refresh_failed_at: now,
        refresh_error: error.message,
      },
      expectedRev,
    );
    throw error;
  }

  // Cache the whole feed when the provider can serve it tolerantly; otherwise
  // request just the configured currencies.
  #fetchProviderRates(
    provider: OpenReceiveSourcedPriceProvider,
  ): Promise<OpenReceiveBtcFiatRateMap> {
    if (providerHasGetAllBtcFiatRates(provider)) {
      return provider.getAllBtcFiatRates();
    }
    return provider.getBtcFiatRates(this.#currencies);
  }

  async #writeCacheState(state: PriceFeedCacheState, expectedRev: number | null): Promise<void> {
    // A concurrent writer winning the CAS is fine; later callers observe it.
    await this.#cache.casMeta(this.#cacheKey, serializePriceFeedCacheState(state), expectedRev);
  }
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

  if (entry === undefined && refreshStartedAt === undefined && refreshFailedAt === undefined) {
    return undefined;
  }

  return {
    ...(entry === undefined ? {} : { entry }),
    ...(refreshStartedAt === undefined ? {} : { refresh_started_at: refreshStartedAt }),
    ...(refreshFailedAt === undefined ? {} : { refresh_failed_at: refreshFailedAt }),
    ...(refreshError === undefined ? {} : { refresh_error: refreshError }),
  };
}

function parsePriceFeedCacheEntry(
  record: Record<string, unknown>,
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
    fetched_at: fetchedAt as number,
  };
}

function serializePriceFeedCacheState(state: PriceFeedCacheState): string {
  return JSON.stringify({
    ...(state.entry === undefined
      ? {}
      : {
          rates: state.entry.rates,
          source: state.entry.source,
          fetched_at: state.entry.fetched_at,
        }),
    ...(state.refresh_started_at === undefined
      ? {}
      : { refresh_started_at: state.refresh_started_at }),
    ...(state.refresh_failed_at === undefined
      ? {}
      : { refresh_failed_at: state.refresh_failed_at }),
    ...(state.refresh_error === undefined ? {} : { refresh_error: state.refresh_error }),
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
  fallbackTimeoutMs?: number;
}): CachedPriceFeed {
  const { primary, fallback } = createLivePriceFeedProviders({
    fetch: options.fetch,
    primaryUrl: options.primaryUrl,
    fallbackUrl: options.fallbackUrl,
    primaryTimeoutMs: options.primaryTimeoutMs,
    fallbackTimeoutMs: options.fallbackTimeoutMs,
  });

  return new CachedPriceFeed({
    currencies: options.currencies,
    primary,
    fallback,
    cacheSeconds: options.cacheSeconds,
    clock: options.clock,
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

/**
 * Try each provider in order and report which one answered.
 *
 * @throws {OpenReceivePriceFeedError} when no provider answers usably.
 */
export async function getBtcFiatRatesWithFallback(input: {
  currencies: readonly string[];
  providers: readonly OpenReceiveSourcedPriceProvider[];
}): Promise<OpenReceiveBtcFiatRateMapWithSource> {
  if (input.providers.length === 0) {
    throw new OpenReceivePriceFeedError("at least one price provider is required");
  }

  const failures: string[] = [];
  for (const provider of input.providers) {
    try {
      if (isResolvedPriceProvider(provider)) {
        return await provider.getBtcFiatRatesWithSource(input.currencies);
      }
      return {
        source: provider.source,
        rates: await provider.getBtcFiatRates(input.currencies),
      };
    } catch (error) {
      failures.push(
        `${provider.source}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  throw new OpenReceivePriceFeedError(`all price providers failed: ${failures.join("; ")}`);
}
