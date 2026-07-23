interface SwapCacheState {
  readonly value?: string;
  readonly fetchedAt?: number;
  readonly failedAt?: number;
  readonly error?: string;
}

export const SWAP_LIMITS_REFRESH_SECONDS = 24 * 60 * 60;
export const SWAP_LIMITS_MAX_STALE_SECONDS = 48 * 60 * 60;
export const SWAP_LIMITS_REFRESH_CLAIM_SECONDS = 60;

export function swapLimitsMetaKey(providerName: string): string {
  return `swap_limits:${providerName}`;
}

export interface SwapCacheResolveOptions<T> {
  readonly refreshSeconds: number;
  readonly maxStaleSeconds: number;
  readonly claimSeconds?: number;
  readonly serveStaleOnFailure?: boolean;
  readonly fetch: () => Promise<T>;
  readonly serialize: (value: T) => string;
  readonly deserialize: (value: string) => T;
}

export interface TransientSwapCacheOptions {
  readonly warn?: (message: string, fields?: Record<string, unknown>) => void;
}

/** Disposable, process-local provider catalog/rate cache. It has no storage adapter. */
export class TransientSwapCache {
  readonly #states = new Map<string, SwapCacheState>();
  readonly #inflight = new Map<string, Promise<unknown>>();
  readonly #clock: () => number;
  readonly #warn: (message: string, fields?: Record<string, unknown>) => void;

  constructor(clock: () => number, options: TransientSwapCacheOptions = {}) {
    this.#clock = clock;
    this.#warn = options.warn ?? (() => {});
  }

  async resolve<T>(key: string, options: SwapCacheResolveOptions<T>): Promise<T> {
    const now = this.#clock();
    const state = this.#states.get(key);
    if (state?.value !== undefined && state.fetchedAt !== undefined && now - state.fetchedAt < options.refreshSeconds) {
      return options.deserialize(state.value);
    }
    const claimSeconds = options.claimSeconds ?? SWAP_LIMITS_REFRESH_CLAIM_SECONDS;
    if (state?.failedAt !== undefined && now - state.failedAt < claimSeconds) {
      return this.#staleOrThrow(key, state, now, options);
    }
    const active = this.#inflight.get(key) as Promise<T> | undefined;
    if (active !== undefined) return await active;

    const refresh = this.#refresh(key, state, now, options);
    this.#inflight.set(key, refresh);
    try {
      return await refresh;
    } finally {
      if (this.#inflight.get(key) === refresh) this.#inflight.delete(key);
    }
  }

  async #refresh<T>(key: string, previous: SwapCacheState | undefined, now: number, options: SwapCacheResolveOptions<T>): Promise<T> {
    try {
      const value = await options.fetch();
      this.#states.set(key, { value: options.serialize(value), fetchedAt: now });
      return value;
    } catch (error) {
      const failed: SwapCacheState = {
        ...(previous?.value === undefined ? {} : { value: previous.value }),
        ...(previous?.fetchedAt === undefined ? {} : { fetchedAt: previous.fetchedAt }),
        failedAt: now,
        error: error instanceof Error ? error.message : String(error),
      };
      this.#states.set(key, failed);
      return this.#staleOrThrow(key, failed, now, options, error);
    }
  }

  #staleOrThrow<T>(key: string, state: SwapCacheState, now: number, options: SwapCacheResolveOptions<T>, cause?: unknown): T {
    if (
      options.serveStaleOnFailure !== false &&
      state.value !== undefined &&
      state.fetchedAt !== undefined &&
      now - state.fetchedAt < options.maxStaleSeconds
    ) {
      this.#warn("Serving stale swap provider data after refresh failed.", { key, error: state.error });
      return options.deserialize(state.value);
    }
    if (cause instanceof Error) throw cause;
    throw new Error(state.error ?? "Swap provider cache refresh failed.");
  }
}
