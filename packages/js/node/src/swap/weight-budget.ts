import { compact } from "@openreceive/core";

export const SWAP_PROVIDER_WEIGHT_WINDOW_SECONDS = 60;
export const SWAP_PROVIDER_WEIGHT_SOFT_CAP = 200;
export const SWAP_PROVIDER_CREATE_WEIGHT_GATE = 150;
export const SWAP_PROVIDER_CREATE_WEIGHT = 50;
export const SWAP_PROVIDER_DEFAULT_WEIGHT = 1;
export const SWAP_PROVIDER_WEIGHT_BACKOFF_SECONDS = 60;

/**
 * What one provider allows an API key per window, as far as this guard needs
 * to know it. The guard exists so a busy site stays inside the provider's
 * limits; the provider remains the authority and its 429 always wins.
 */
export interface SwapProviderLimits {
  /** Whose published limits these are. */
  readonly profile: "fixedfloat" | "lightning-swap";
  /** Weight every call in one window may add up to. */
  readonly softCap: number;
  /** Weight a create may bring the window up to. */
  readonly createGate: number;
  readonly createWeight: number;
  readonly defaultWeight: number;
  /** Creates per window, for a provider that counts them on their own. */
  readonly createLimit?: number;
  /** Stand-off after a 429 that names no wait. */
  readonly backoffSeconds: number;
  /** Shortest and longest stand-off a 429's own wait is honored for. */
  readonly minBackoffSeconds: number;
  readonly maxBackoffSeconds: number;
  /**
   * True when the provider counts new swaps apart from its other calls, so a
   * 429 answering a create stops creates only. Status and refund calls for
   * swaps that already exist keep working.
   */
  readonly createBackoffOnly: boolean;
}

/**
 * FixedFloat: 250 weight a minute per key, a create costs 50, and going over
 * blocks the key for longer each time. The guard stops well short: three
 * creates a minute, 200 weight in all. Also the default for a provider this
 * library does not know, because it is the stricter of the two.
 */
export const FIXEDFLOAT_SWAP_PROVIDER_LIMITS: SwapProviderLimits = Object.freeze({
  profile: "fixedfloat",
  softCap: SWAP_PROVIDER_WEIGHT_SOFT_CAP,
  createGate: SWAP_PROVIDER_CREATE_WEIGHT_GATE,
  createWeight: SWAP_PROVIDER_CREATE_WEIGHT,
  defaultWeight: SWAP_PROVIDER_DEFAULT_WEIGHT,
  backoffSeconds: SWAP_PROVIDER_WEIGHT_BACKOFF_SECONDS,
  minBackoffSeconds: SWAP_PROVIDER_WEIGHT_BACKOFF_SECONDS,
  maxBackoffSeconds: 3_600,
  createBackoffOnly: false,
});

/**
 * Lightning Swap: per account, 30 new swaps and 400 API calls a minute once
 * the account has completed a swap, every call counting as one. It refuses
 * with a 429 that says how long to wait and never blocks a key for going
 * over, so the guard sits at the limit itself. An account on lower limits
 * (one that has not completed a swap yet) is held to them by the provider's
 * own 429, which this guard then obeys.
 */
export const LIGHTNING_SWAP_PROVIDER_LIMITS: SwapProviderLimits = Object.freeze({
  profile: "lightning-swap",
  softCap: 400,
  createGate: 400,
  createWeight: 1,
  defaultWeight: 1,
  createLimit: 30,
  backoffSeconds: 60,
  minBackoffSeconds: 1,
  maxBackoffSeconds: 300,
  createBackoffOnly: true,
});

const LIGHTNING_SWAP_HOST = "lightning-swap.com";

/** The limits to guard a provider API with, chosen by its HTTPS host. */
export function swapProviderLimitsForBaseUrl(baseUrl: string): SwapProviderLimits {
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return FIXEDFLOAT_SWAP_PROVIDER_LIMITS;
  }
  return hostname === LIGHTNING_SWAP_HOST || hostname.endsWith(`.${LIGHTNING_SWAP_HOST}`)
    ? LIGHTNING_SWAP_PROVIDER_LIMITS
    : FIXEDFLOAT_SWAP_PROVIDER_LIMITS;
}

export type SwapWeightBudgetDenialReason = "exhausted" | "backoff";

export interface SwapWeightBudgetDenial {
  readonly provider: string;
  readonly path: string;
  readonly reason: SwapWeightBudgetDenialReason;
  readonly message: string;
  readonly used: number;
  readonly cost: number;
  readonly gate: number;
  readonly window_start: number;
  readonly backoff_until?: number;
  readonly creates?: number;
  readonly create_limit?: number;
}

/** What a provider's 429 said, for {@link SwapProviderWeightBudget.markRateLimited}. */
export interface SwapProviderRateLimitNotice {
  /** The API path the 429 answered. */
  readonly path?: string;
  /** The provider's own wait, from `Retry-After` or its response body. */
  readonly retryAfterSeconds?: number;
}

/** Disposable per-process request guard; the provider remains global rate-limit authority. */
export class SwapProviderWeightBudget {
  #windowStart: number;
  #used = 0;
  #creates = 0;
  #backoffUntil: number | undefined;
  #createBackoffUntil: number | undefined;

  constructor(
    private readonly providerId: string,
    private readonly now: () => number,
    private readonly limits: SwapProviderLimits = FIXEDFLOAT_SWAP_PROVIDER_LIMITS,
  ) {
    this.#windowStart = now();
  }

  weightForPath(path: string): number {
    return path === "create" ? this.limits.createWeight : this.limits.defaultWeight;
  }

  /**
   * Throw the same denial `reserve` would, without using any budget. Lets a
   * caller refuse a new swap before it does any other work for it.
   */
  async assertAvailable(path: string): Promise<void> {
    this.#rollWindow();
    const now = this.now();
    const cost = this.weightForPath(path);
    const gate = this.#gate(path);
    const backoffUntil = this.#activeBackoff(path, now);
    if (backoffUntil !== undefined) {
      this.#deny(
        path,
        "backoff",
        cost,
        gate,
        `Swap provider API is in backoff until ${backoffUntil}.`,
        backoffUntil,
      );
    }
    if (this.#used + cost > gate) {
      this.#deny(
        path,
        "exhausted",
        cost,
        gate,
        `Swap provider API weight budget exhausted (${this.#used}+${cost} > ${gate}).`,
      );
    }
    const createLimit = this.limits.createLimit;
    if (path === "create" && createLimit !== undefined && this.#creates + 1 > createLimit) {
      this.#deny(
        path,
        "exhausted",
        cost,
        gate,
        `Swap provider create budget exhausted (${this.#creates}+1 > ${createLimit}).`,
      );
    }
  }

  async reserve(path: string): Promise<void> {
    await this.assertAvailable(path);
    this.#used += this.weightForPath(path);
    if (path === "create") this.#creates += 1;
  }

  async markRateLimited(notice: SwapProviderRateLimitNotice = {}): Promise<void> {
    const until = this.now() + this.#backoffSeconds(notice.retryAfterSeconds);
    if (this.limits.createBackoffOnly && notice.path === "create") {
      this.#createBackoffUntil = Math.max(this.#createBackoffUntil ?? 0, until);
      return;
    }
    this.#backoffUntil = Math.max(this.#backoffUntil ?? 0, until);
    // The provider's own window is spent until then and fresh after it, so
    // this guard's window restarts when the stand-off ends. Keeping the old
    // count would go on refusing calls the provider has started accepting.
    this.#windowStart = this.#backoffUntil;
    this.#used = 0;
    this.#creates = 0;
  }

  #backoffSeconds(retryAfterSeconds: number | undefined): number {
    const { backoffSeconds, minBackoffSeconds, maxBackoffSeconds } = this.limits;
    if (
      retryAfterSeconds === undefined ||
      !Number.isFinite(retryAfterSeconds) ||
      retryAfterSeconds <= 0
    ) {
      return backoffSeconds;
    }
    return Math.min(Math.max(Math.ceil(retryAfterSeconds), minBackoffSeconds), maxBackoffSeconds);
  }

  #activeBackoff(path: string, now: number): number | undefined {
    if (this.#backoffUntil !== undefined && this.#backoffUntil > now) return this.#backoffUntil;
    if (
      path === "create" &&
      this.#createBackoffUntil !== undefined &&
      this.#createBackoffUntil > now
    ) {
      return this.#createBackoffUntil;
    }
    return undefined;
  }

  // The weight window rolls; the 429 backoff does NOT ride along with it.
  // Clearing it here cut a backoff arbitrarily short — markRateLimited() at
  // second 59 of the window was forgiven one second later — so the backoff
  // expires on its own clock, checked in assertAvailable().
  #rollWindow(): void {
    const now = this.now();
    if (now - this.#windowStart < SWAP_PROVIDER_WEIGHT_WINDOW_SECONDS) return;
    this.#windowStart = now;
    this.#used = 0;
    this.#creates = 0;
  }

  #gate(path: string): number {
    return path === "create" ? this.limits.createGate : this.limits.softCap;
  }

  // The denial carries its own diagnostics on the thrown error: there is no
  // observer hook, because there was never a caller for one — the service maps
  // a weight-budget throw to a retryable 503 and logs it there.
  #deny(
    path: string,
    reason: SwapWeightBudgetDenialReason,
    cost: number,
    gate: number,
    message: string,
    backoffUntil?: number,
  ): never {
    throw weightBudgetError(
      message,
      compact({
        provider: this.providerId,
        path,
        reason,
        message,
        used: this.#used,
        cost,
        gate,
        window_start: this.#windowStart,
        backoff_until: backoffUntil ?? this.#backoffUntil,
        creates: this.limits.createLimit === undefined ? undefined : this.#creates,
        create_limit: this.limits.createLimit,
      }),
    );
  }
}

function weightBudgetError(
  message: string,
  denial: SwapWeightBudgetDenial,
): Error & { readonly weightBudget: true; readonly denial: SwapWeightBudgetDenial } {
  const error = new Error(message) as Error & {
    readonly weightBudget: true;
    readonly denial: SwapWeightBudgetDenial;
  };
  Object.defineProperty(error, "weightBudget", { value: true });
  Object.defineProperty(error, "denial", { value: denial, enumerable: true });
  return error;
}

export function isSwapProviderWeightBudgetError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "weightBudget" in error &&
    (error as { weightBudget?: unknown }).weightBudget === true
  );
}

/** The denial a weight-budget error carries, for the log line that reports it. */
export function swapProviderWeightBudgetDenial(error: unknown): SwapWeightBudgetDenial | undefined {
  if (!isSwapProviderWeightBudgetError(error)) return undefined;
  return (error as { denial?: SwapWeightBudgetDenial }).denial;
}
