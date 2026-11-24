import { compact } from "@openreceive/core";

export const SWAP_PROVIDER_WEIGHT_WINDOW_SECONDS = 60;
const SWAP_PROVIDER_WEIGHT_BACKOFF_SECONDS = 60;

/**
 * The per-window count the guard keeps for a provider that needs one. Every
 * call adds its weight to the window; a create may bring the window up to the
 * whole soft cap, and the calls that are not creates (status, refund,
 * catalog) may use only `nonCreateCap` of it between them, so open swap
 * screens polling their status never starve new swaps.
 */
export interface SwapProviderLocalBudget {
  /** Weight every call in one window may add up to. */
  readonly softCap: number;
  /** Weight the calls that are not creates may use between them in one window. */
  readonly nonCreateCap: number;
  readonly createWeight: number;
  readonly defaultWeight: number;
}

/**
 * How the request guard treats one provider. The provider remains the
 * authority: its 429 always starts a stand-off. Only a provider that punishes
 * going over also gets a local count, so a busy site never asks too often.
 */
export interface SwapProviderLimits {
  /** `fixedfloat` for FixedFloat's own host; `provider-only` for every other. */
  readonly profile: "fixedfloat" | "provider-only";
  /** The per-window count, or undefined when the guard keeps none and only obeys the provider's 429. */
  readonly localBudget?: SwapProviderLocalBudget;
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
 * blocks the key for longer each time. So the guard counts: 200 weight a
 * minute in all, of which the calls that are not creates may use 50. At least
 * three creates a minute always fit, four when nothing else ran. A 429 stops
 * every call for at least a minute.
 */
export const FIXEDFLOAT_SWAP_PROVIDER_LIMITS: SwapProviderLimits = Object.freeze({
  profile: "fixedfloat",
  localBudget: Object.freeze({
    softCap: 200,
    nonCreateCap: 50,
    createWeight: 50,
    defaultWeight: 1,
  }),
  backoffSeconds: SWAP_PROVIDER_WEIGHT_BACKOFF_SECONDS,
  minBackoffSeconds: SWAP_PROVIDER_WEIGHT_BACKOFF_SECONDS,
  maxBackoffSeconds: 3_600,
  createBackoffOnly: false,
});

/**
 * Every other provider (Lightning Swap, one this library does not know, a
 * test fake): no local count. The provider limits its own accounts and says
 * so with a 429; a count of this library's own could only refuse payers the
 * provider would have accepted. A 429 that answered a create stops creates
 * only, for the wait it names (1 to 300 seconds; a minute when it names none).
 * Lightning Swap answers this way: it counts new swaps apart from its other
 * calls, per account, and names the wait in `Retry-After`.
 */
export const PROVIDER_ONLY_SWAP_PROVIDER_LIMITS: SwapProviderLimits = Object.freeze({
  profile: "provider-only",
  backoffSeconds: 60,
  minBackoffSeconds: 1,
  maxBackoffSeconds: 300,
  createBackoffOnly: true,
});

const FIXEDFLOAT_HOST = "ff.io";

/** The limits to guard a provider API with, chosen by its HTTPS host. */
export function swapProviderLimitsForBaseUrl(baseUrl: string): SwapProviderLimits {
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return PROVIDER_ONLY_SWAP_PROVIDER_LIMITS;
  }
  return hostname === FIXEDFLOAT_HOST || hostname.endsWith(`.${FIXEDFLOAT_HOST}`)
    ? FIXEDFLOAT_SWAP_PROVIDER_LIMITS
    : PROVIDER_ONLY_SWAP_PROVIDER_LIMITS;
}

export type SwapWeightBudgetDenialReason = "exhausted" | "backoff";

export interface SwapWeightBudgetDenial {
  readonly provider: string;
  readonly path: string;
  readonly reason: SwapWeightBudgetDenialReason;
  readonly message: string;
  /** Weight already used against `gate`; only for a guard that counts. */
  readonly used?: number;
  readonly cost?: number;
  /** The cap that refused (or would refuse) this call; only for a guard that counts. */
  readonly gate?: number;
  readonly window_start?: number;
  readonly backoff_until?: number;
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
  #nonCreateUsed = 0;
  #backoffUntil: number | undefined;
  #createBackoffUntil: number | undefined;

  constructor(
    private readonly providerId: string,
    private readonly now: () => number,
    private readonly limits: SwapProviderLimits = PROVIDER_ONLY_SWAP_PROVIDER_LIMITS,
  ) {
    this.#windowStart = now();
  }

  /**
   * Throw the same denial `reserve` would, without using any budget. Lets a
   * caller refuse a new swap before it does any other work for it.
   */
  async assertAvailable(path: string): Promise<void> {
    this.#check(path);
  }

  async reserve(path: string): Promise<void> {
    const cost = this.#check(path);
    if (cost === undefined) return;
    this.#used += cost;
    if (path !== "create") this.#nonCreateUsed += cost;
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
    this.#nonCreateUsed = 0;
  }

  /** Deny `path`, or return what reserving it costs (undefined: nothing is counted). */
  #check(path: string): number | undefined {
    this.#rollWindow();
    const backoffUntil = this.#activeBackoff(path, this.now());
    const budget = this.limits.localBudget;
    if (backoffUntil !== undefined) {
      this.#deny(
        path,
        "backoff",
        `Swap provider API is in backoff until ${backoffUntil}.`,
        budget === undefined ? undefined : this.#weigh(path, budget),
        backoffUntil,
      );
    }
    if (budget === undefined) return undefined;
    const cost = path === "create" ? budget.createWeight : budget.defaultWeight;
    if (this.#used + cost > budget.softCap) {
      this.#deny(
        path,
        "exhausted",
        `Swap provider API weight budget exhausted (${this.#used}+${cost} > ${budget.softCap}).`,
        { used: this.#used, cost, gate: budget.softCap },
      );
    }
    if (path !== "create" && this.#nonCreateUsed + cost > budget.nonCreateCap) {
      this.#deny(
        path,
        "exhausted",
        `Swap provider API weight budget for calls other than creates exhausted ` +
          `(${this.#nonCreateUsed}+${cost} > ${budget.nonCreateCap}).`,
        { used: this.#nonCreateUsed, cost, gate: budget.nonCreateCap },
      );
    }
    return cost;
  }

  #weigh(
    path: string,
    budget: SwapProviderLocalBudget,
  ): { readonly used: number; readonly cost: number; readonly gate: number } {
    return path === "create"
      ? { used: this.#used, cost: budget.createWeight, gate: budget.softCap }
      : { used: this.#nonCreateUsed, cost: budget.defaultWeight, gate: budget.nonCreateCap };
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
  // expires on its own clock, checked in #check().
  #rollWindow(): void {
    const now = this.now();
    if (now - this.#windowStart < SWAP_PROVIDER_WEIGHT_WINDOW_SECONDS) return;
    this.#windowStart = now;
    this.#used = 0;
    this.#nonCreateUsed = 0;
  }

  // The denial carries its own diagnostics on the thrown error: there is no
  // observer hook, because there was never a caller for one — the service maps
  // a weight-budget throw to a retryable 503 and logs it there.
  #deny(
    path: string,
    reason: SwapWeightBudgetDenialReason,
    message: string,
    weight?: { readonly used: number; readonly cost: number; readonly gate: number },
    backoffUntil?: number,
  ): never {
    throw weightBudgetError(
      message,
      compact({
        provider: this.providerId,
        path,
        reason,
        message,
        used: weight?.used,
        cost: weight?.cost,
        gate: weight?.gate,
        window_start: this.limits.localBudget === undefined ? undefined : this.#windowStart,
        backoff_until: backoffUntil ?? this.#backoffUntil,
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
