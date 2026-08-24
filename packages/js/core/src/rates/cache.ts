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

import { type BtcFiatRateMap, PriceFeedError } from "../money/decimal.ts";
import { unixSeconds } from "../values.ts";
import {
  OPENRECEIVE_INVOICE_QUOTE_TTL_SECONDS,
  OPENRECEIVE_PRICE_FEED_CACHE_SECONDS,
  OPENRECEIVE_PRICE_FEED_CLOCK_SKEW_SECONDS,
} from "./constants.ts";
import { createLivePriceFeedProviders } from "./http.ts";
import { parseSimplePriceResponse } from "./parsing.ts";
import {
  isResolvedPriceProvider,
  type BtcFiatRateMapWithSource,
  type LivePriceSourceId,
  type PriceFeedHealthCheck,
  type ResolvedPriceProvider,
  type SourcedPriceProvider,
  providerHasGetAllBtcFiatRates,
  type SimplePriceFetch,
} from "./types.ts";

interface PriceFeedCacheEntry {
  rates: BtcFiatRateMap;
  source: LivePriceSourceId;
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
  primary: SourcedPriceProvider;
  fallback: SourcedPriceProvider;
  cacheSeconds?: number;
  clock?: () => number;
}

/**
 * Serves BTC fiat rates from a disposable process-local cache, refreshing from
 * the primary feed first and the fallback second.
 */
export class CachedPriceFeed implements ResolvedPriceProvider, PriceFeedHealthCheck {
  // Representative source for the bare SourcedPriceProvider view;
  // the true origin is reported per-call by getBtcFiatRatesWithSource.
  readonly source: LivePriceSourceId = "primary";
  // Plain in-process state. Price caching is disposable and OpenReceive has no
  // storage configuration, so this is a field on one object that only this
  // class writes — not a store that can be raced, replaced, or corrupted. The
  // single-fetcher guarantee is #inFlight below, not a revision number.
  #state: PriceFeedCacheState | undefined;
  readonly #currencies: readonly string[];
  readonly #primary: SourcedPriceProvider;
  readonly #fallback: SourcedPriceProvider;
  readonly #cacheSeconds: number;
  readonly #clock: () => number;
  #inFlight?: Promise<PriceFeedCacheEntry>;

  constructor(options: CachedPriceFeedOptions) {
    // Construction failures are host misconfiguration (a boot bug), never payer
    // input: throw TypeError — matching the Ruby port's constructor validation —
    // not the 400-mapped DecimalError.
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
    this.#currencies = [...options.currencies];
    this.#primary = options.primary;
    this.#fallback = options.fallback;
    this.#cacheSeconds = cacheSeconds;
    this.#clock = options.clock ?? unixSeconds;
  }

  async getBtcFiatRates(currencies: readonly string[]): Promise<BtcFiatRateMap> {
    return (await this.getBtcFiatRatesWithSource(currencies)).rates;
  }

  /**
   * @throws {PriceFeedError} when no rate recent enough to price a
   * quote can be served — always retryable, never payer input.
   */
  async getBtcFiatRatesWithSource(
    currencies: readonly string[],
  ): Promise<BtcFiatRateMapWithSource> {
    const now = this.#clock();
    const claimed = this.#readOrClaimRefresh(now);
    const resolved = claimed.status === "served" ? claimed.entry : await claimed.pending;
    return {
      source: resolved.source,
      rates: parseSimplePriceResponse(resolved.rates, currencies, resolved.source),
    };
  }

  // Forces a live refresh, ignoring the cache, for explicit operational probes.
  // Throws if both feeds fail. Tolerant of an upstream that drops an individual
  // currency.
  async healthCheck(currencies?: readonly string[]): Promise<BtcFiatRateMapWithSource> {
    const now = this.#clock();
    const resolved = await this.#trackedRefresh(now, this.#state?.entry);
    return {
      source: resolved.source,
      rates:
        currencies === undefined || currencies.length === 0
          ? resolved.rates
          : parseSimplePriceResponse(resolved.rates, currencies, resolved.source),
    };
  }

  #readOrClaimRefresh(now: number): PriceFeedRefreshClaim {
    const state = this.#state;
    const freshEntry = this.#freshEntry(state, now);
    if (freshEntry !== undefined) {
      return { status: "served", entry: freshEntry };
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
      throw new PriceFeedError(
        `price feed refresh already failed within ${this.#cacheSeconds}s${
          state?.refresh_error === undefined ? "" : `: ${state.refresh_error}`
        }`,
      );
    }

    if (this.#isRecent(state?.refresh_started_at, now)) {
      if (usableEntry !== undefined) {
        return { status: "served", entry: usableEntry };
      }
      // Cold cache: join the refresh already running rather than failing every
      // concurrent caller but the one that claimed it.
      const pending = this.#inFlight;
      if (pending !== undefined) {
        return { status: "pending", pending };
      }
      throw new PriceFeedError(`price feed refresh already started within ${this.#cacheSeconds}s`);
    }

    // Claim the refresh. Synchronous from the freshness read to this write, so
    // no second caller can interleave and start a duplicate fetch.
    this.#state = {
      ...(state?.entry === undefined ? {} : { entry: state.entry }),
      refresh_started_at: now,
    };
    return { status: "pending", pending: this.#trackedRefresh(now, state?.entry) };
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
    previousEntry: PriceFeedCacheEntry | undefined,
  ): Promise<PriceFeedCacheEntry> {
    const pending = this.#refresh(now, previousEntry);
    this.#inFlight = pending;
    const clear = () => {
      if (this.#inFlight === pending) this.#inFlight = undefined;
    };
    pending.then(clear, clear);
    return pending;
  }

  async #refresh(
    now: number,
    previousEntry: PriceFeedCacheEntry | undefined,
  ): Promise<PriceFeedCacheEntry> {
    const failures: string[] = [];
    for (const provider of [this.#primary, this.#fallback]) {
      try {
        const rates = await this.#fetchProviderRates(provider);
        const source = provider.source as LivePriceSourceId;
        const entry: PriceFeedCacheEntry = { rates, source, fetched_at: now };
        this.#state = { entry };
        return entry;
      } catch (error) {
        failures.push(
          `${provider.source}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const error = new PriceFeedError(`all price feeds failed: ${failures.join("; ")}`);
    this.#state = {
      ...(previousEntry === undefined ? {} : { entry: previousEntry }),
      refresh_started_at: now,
      refresh_failed_at: now,
      refresh_error: error.message,
    };
    throw error;
  }

  // Cache the whole feed when the provider can serve it tolerantly; otherwise
  // request just the configured currencies.
  #fetchProviderRates(provider: SourcedPriceProvider): Promise<BtcFiatRateMap> {
    if (providerHasGetAllBtcFiatRates(provider)) {
      return provider.getAllBtcFiatRates();
    }
    return provider.getBtcFiatRates(this.#currencies);
  }
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

/**
 * Try each provider in order and report which one answered.
 *
 * @throws {PriceFeedError} when no provider answers usably.
 */
export async function getBtcFiatRatesWithFallback(input: {
  currencies: readonly string[];
  providers: readonly SourcedPriceProvider[];
}): Promise<BtcFiatRateMapWithSource> {
  if (input.providers.length === 0) {
    throw new PriceFeedError("at least one price provider is required");
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

  throw new PriceFeedError(`all price providers failed: ${failures.join("; ")}`);
}
