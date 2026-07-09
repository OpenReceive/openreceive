import type { MaybePromise, MetaRow } from "@openreceive/core";

/**
 * How old a cached provider limits blob may be before we refresh it from the
 * provider. Reads inside this window are served straight from the store.
 */
export const SWAP_LIMITS_REFRESH_SECONDS = 24 * 60 * 60;

/**
 * How old a cached blob may be and still be served when a refresh fails. Past
 * this window a failing provider surfaces the error instead of stale limits.
 */
export const SWAP_LIMITS_MAX_STALE_SECONDS = 48 * 60 * 60;

/**
 * How long a claimed (in-flight) or recently failed refresh is treated as
 * current, so concurrent instances don't all call the provider at once. Kept
 * short — much shorter than the 24h refresh window — so a crashed refresh
 * retries promptly instead of blocking for a day.
 */
export const SWAP_LIMITS_REFRESH_CLAIM_SECONDS = 60;

export function swapLimitsMetaKey(providerName: string): string {
  return `swap_limits:${providerName}`;
}

/**
 * The two-method subset of the durable KV store this cache needs: a single
 * versioned key it reads and compare-and-set writes. Mirrors
 * OpenReceivePriceFeedCacheStore from the rates module.
 */
export interface SwapCacheStore {
  getMeta(key: string): MaybePromise<MetaRow | undefined>;
  casMeta(
    key: string,
    value: string,
    expectedRev: number | null,
  ): MaybePromise<{ status: "ok" | "conflict"; row: MetaRow }>;
}

interface SwapCacheState {
  readonly value?: string;
  readonly fetched_at?: number;
  readonly refresh_started_at?: number;
  readonly refresh_failed_at?: number;
  readonly refresh_error?: string;
}

export interface SwapCacheResolveOptions<T> {
  readonly refreshSeconds: number;
  readonly maxStaleSeconds: number;
  readonly claimSeconds?: number;
  /**
   * When false, a failed refresh throws instead of serving a stale blob.
   * Use for fast-moving data (swap rates) where failover to the next provider
   * is better than an outdated quote. Defaults to true (currency catalogs).
   */
  readonly serveStaleOnFailure?: boolean;
  readonly fetch: () => Promise<T>;
  readonly serialize: (value: T) => string;
  readonly deserialize: (value: string) => T;
}

export interface StoreBackedSwapCacheOptions {
  readonly warn?: (message: string, fields?: Record<string, unknown>) => void;
}

/**
 * Serves slow-changing swap-provider data (currency catalogs, min/max limits)
 * from the durable KV store instead of process memory, so it survives restarts
 * and is shared across serverless instances. The value is stored as an opaque
 * serialized blob alongside its fetch time; refreshes are claimed in the same
 * store row before any provider call, which keeps concurrent instances from all
 * hitting the provider when the cache goes stale. Modeled on CachedPriceFeed.
 */
export class StoreBackedSwapCache {
  readonly #store: SwapCacheStore;
  readonly #clock: () => number;
  readonly #warn: (message: string, fields?: Record<string, unknown>) => void;

  constructor(
    store: SwapCacheStore,
    clock: () => number,
    options: StoreBackedSwapCacheOptions = {},
  ) {
    this.#store = store;
    this.#clock = clock;
    this.#warn = options.warn ?? (() => {});
  }

  async resolve<T>(key: string, options: SwapCacheResolveOptions<T>): Promise<T> {
    const now = this.#clock();
    const claimSeconds = options.claimSeconds ?? SWAP_LIMITS_REFRESH_CLAIM_SECONDS;
    const serveStaleOnFailure = options.serveStaleOnFailure !== false;
    let meta = await this.#store.getMeta(key);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const state = parseSwapCacheState(meta?.value);
      const fresh = freshValue(state, now, options.refreshSeconds);
      if (fresh !== undefined) return options.deserialize(fresh);

      // A recent failed refresh: either serve the last good value (catalogs) or
      // surface the error so callers can fail over to the next provider (rates).
      if (isRecent(state?.refresh_failed_at, now, claimSeconds)) {
        if (
          serveStaleOnFailure &&
          state?.value !== undefined &&
          state.fetched_at !== undefined &&
          now - state.fetched_at < options.maxStaleSeconds
        ) {
          return options.deserialize(state.value);
        }
        throw new Error(state?.refresh_error ?? "Swap provider cache refresh failed.");
      }

      // Another instance is already refreshing: serve its last good value rather
      // than piling on a second provider call (even for rates — the in-flight
      // fetch is seconds away from completing).
      if (state?.value !== undefined && isRecent(state.refresh_started_at, now, claimSeconds)) {
        return options.deserialize(state.value);
      }

      // Claim the refresh in the store row before calling the provider.
      const claim = await this.#store.casMeta(
        key,
        serializeSwapCacheState({
          ...carryPreviousValue(state),
          refresh_started_at: now,
        }),
        meta === undefined ? null : meta.rev,
      );
      if (claim.status === "ok") {
        return await this.#refresh(key, now, claim.row.rev, state, options);
      }
      // Lost the CAS: re-read the winner's row and re-evaluate.
      meta = claim.row.rev < 0 ? undefined : claim.row;
    }

    // Contended too many times: serve whatever value is stored, else fetch
    // directly without caching rather than fail the caller.
    const latest = parseSwapCacheState((await this.#store.getMeta(key))?.value);
    if (latest?.value !== undefined) return options.deserialize(latest.value);
    return await options.fetch();
  }

  async #refresh<T>(
    key: string,
    now: number,
    expectedRev: number,
    previous: SwapCacheState | undefined,
    options: SwapCacheResolveOptions<T>,
  ): Promise<T> {
    const serveStaleOnFailure = options.serveStaleOnFailure !== false;
    try {
      const value = await options.fetch();
      await this.#store.casMeta(
        key,
        serializeSwapCacheState({ value: options.serialize(value), fetched_at: now }),
        expectedRev,
      );
      return value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#store.casMeta(
        key,
        serializeSwapCacheState({
          ...carryPreviousValue(previous),
          refresh_failed_at: now,
          refresh_error: message,
        }),
        expectedRev,
      );
      // Serve stale catalogs within the max-stale window. Rates opt out so a
      // dead feed fails closed and the service can try the next provider.
      if (
        serveStaleOnFailure &&
        previous?.value !== undefined &&
        previous.fetched_at !== undefined &&
        now - previous.fetched_at < options.maxStaleSeconds
      ) {
        this.#warn("Serving stale swap limits after provider refresh failed.", {
          key,
          error: message,
        });
        return options.deserialize(previous.value);
      }
      throw error;
    }
  }
}

function carryPreviousValue(state: SwapCacheState | undefined): SwapCacheState {
  if (state?.value === undefined || state.fetched_at === undefined) return {};
  return { value: state.value, fetched_at: state.fetched_at };
}

function freshValue(
  state: SwapCacheState | undefined,
  now: number,
  refreshSeconds: number,
): string | undefined {
  if (state?.value === undefined || state.fetched_at === undefined) return undefined;
  if (now - state.fetched_at >= refreshSeconds) return undefined;
  return state.value;
}

function isRecent(timestamp: number | undefined, now: number, seconds: number): boolean {
  return timestamp !== undefined && now - timestamp < seconds;
}

function parseSwapCacheState(value: string | undefined): SwapCacheState | undefined {
  if (value === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  return {
    ...(typeof record.value === "string" ? { value: record.value } : {}),
    ...(typeof record.fetched_at === "number" ? { fetched_at: record.fetched_at } : {}),
    ...(typeof record.refresh_started_at === "number"
      ? { refresh_started_at: record.refresh_started_at }
      : {}),
    ...(typeof record.refresh_failed_at === "number"
      ? { refresh_failed_at: record.refresh_failed_at }
      : {}),
    ...(typeof record.refresh_error === "string" ? { refresh_error: record.refresh_error } : {}),
  };
}

function serializeSwapCacheState(state: SwapCacheState): string {
  return JSON.stringify(state);
}
