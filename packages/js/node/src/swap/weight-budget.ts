/**
 * Durable per-provider API weight ledger.
 *
 * Assumes FixedFloat-compatible limits for every swap provider: 250 weight units
 * per minute (`/create` = 50, other calls = 1). Exceeding the budget temporarily
 * blocks the API key with escalating lockouts, so every OpenReceive instance must
 * share one ledger via the store — process memory is not enough under
 * Heroku/multi-dyno deploys.
 *
 * Soft-caps stay below 250 so we never ride the hard edge. Creates are gated more
 * tightly so in-flight `/order` and `/emergency` calls keep headroom.
 *
 * Each configured provider gets its own ledger (`swap_provider_weight:<id>`). When
 * the first provider in `swap.providers` is at its limit, selection fails over to
 * the next provider that still supports the pay-in asset.
 */

export const SWAP_PROVIDER_WEIGHT_WINDOW_SECONDS = 60;
/** Soft cap for all calls (of the assumed hard 250). */
export const SWAP_PROVIDER_WEIGHT_SOFT_CAP = 200;
/**
 * Creates are refused once used weight reaches this. Leaves
 * `SOFT_CAP - CREATE_GATE` units for status/refund traffic.
 */
export const SWAP_PROVIDER_CREATE_WEIGHT_GATE = 150;
export const SWAP_PROVIDER_CREATE_WEIGHT = 50;
export const SWAP_PROVIDER_DEFAULT_WEIGHT = 1;
/** After a provider rate-limit response, back off this many seconds. */
export const SWAP_PROVIDER_WEIGHT_BACKOFF_SECONDS = 60;

/** @deprecated Use {@link SWAP_PROVIDER_WEIGHT_WINDOW_SECONDS}. */
export const FIXED_FLOAT_WEIGHT_WINDOW_SECONDS = SWAP_PROVIDER_WEIGHT_WINDOW_SECONDS;
/** @deprecated Use {@link SWAP_PROVIDER_WEIGHT_SOFT_CAP}. */
export const FIXED_FLOAT_WEIGHT_SOFT_CAP = SWAP_PROVIDER_WEIGHT_SOFT_CAP;
/** @deprecated Use {@link SWAP_PROVIDER_CREATE_WEIGHT_GATE}. */
export const FIXED_FLOAT_CREATE_WEIGHT_GATE = SWAP_PROVIDER_CREATE_WEIGHT_GATE;
/** @deprecated Use {@link SWAP_PROVIDER_CREATE_WEIGHT}. */
export const FIXED_FLOAT_CREATE_WEIGHT = SWAP_PROVIDER_CREATE_WEIGHT;
/** @deprecated Use {@link SWAP_PROVIDER_DEFAULT_WEIGHT}. */
export const FIXED_FLOAT_DEFAULT_WEIGHT = SWAP_PROVIDER_DEFAULT_WEIGHT;
/** @deprecated Use {@link SWAP_PROVIDER_WEIGHT_BACKOFF_SECONDS}. */
export const FIXED_FLOAT_WEIGHT_BACKOFF_SECONDS = SWAP_PROVIDER_WEIGHT_BACKOFF_SECONDS;

export interface SwapWeightBudgetStore {
  getMeta(key: string): Promise<{ value: string; rev: number } | undefined> | { value: string; rev: number } | undefined;
  casMeta(
    key: string,
    value: string,
    expectedRev: number | null,
  ):
    | Promise<{ status: "ok" | "conflict"; row: { value: string; rev: number } }>
    | { status: "ok" | "conflict"; row: { value: string; rev: number } };
}

/** Why an outbound provider call was refused by the local weight ledger. */
export type SwapWeightBudgetDenialReason = "exhausted" | "backoff" | "cas_conflict";

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
}

interface WeightWindow {
  readonly window_start: number;
  readonly used: number;
  readonly backoff_until?: number;
}

export class SwapProviderWeightBudget {
  constructor(
    private readonly store: SwapWeightBudgetStore,
    private readonly providerId: string,
    private readonly now: () => number,
    private readonly onDenied?: (denial: SwapWeightBudgetDenial) => void,
  ) {}

  metaKey(): string {
    return `swap_provider_weight:${this.providerId}`;
  }

  weightForPath(path: string): number {
    return path === "create" ? SWAP_PROVIDER_CREATE_WEIGHT : SWAP_PROVIDER_DEFAULT_WEIGHT;
  }

  /** True when `reserve(path)` would succeed right now (read-only; does not consume). */
  async canReserve(path: string): Promise<boolean> {
    const cost = this.weightForPath(path);
    const gate = path === "create" ? SWAP_PROVIDER_CREATE_WEIGHT_GATE : SWAP_PROVIDER_WEIGHT_SOFT_CAP;
    const now = this.now();
    const current = await this.store.getMeta(this.metaKey());
    const window = parseWeightWindow(current?.value, now);
    if (window.backoff_until !== undefined && window.backoff_until > now) return false;
    return window.used + cost <= gate;
  }

  /**
   * Reserve `cost` weight units for an outbound call. Throws a rate-limit error
   * the provider maps to `provider_rate_limited` / HTTP 429.
   */
  async reserve(path: string): Promise<void> {
    const cost = this.weightForPath(path);
    const gate = path === "create" ? SWAP_PROVIDER_CREATE_WEIGHT_GATE : SWAP_PROVIDER_WEIGHT_SOFT_CAP;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const now = this.now();
      const current = await this.store.getMeta(this.metaKey());
      const window = parseWeightWindow(current?.value, now);
      if (window.backoff_until !== undefined && window.backoff_until > now) {
        const message = `Swap provider API weight budget in backoff until ${window.backoff_until}.`;
        this.emitDenied({
          path,
          reason: "backoff",
          message,
          used: window.used,
          cost,
          gate,
          window_start: window.window_start,
          backoff_until: window.backoff_until,
        });
        throw weightBudgetError(message);
      }
      if (window.used + cost > gate) {
        const message = `Swap provider API weight budget exhausted (${window.used}+${cost} > ${gate}).`;
        this.emitDenied({
          path,
          reason: "exhausted",
          message,
          used: window.used,
          cost,
          gate,
          window_start: window.window_start,
          ...(window.backoff_until === undefined ? {} : { backoff_until: window.backoff_until }),
        });
        throw weightBudgetError(message);
      }
      const next: WeightWindow = {
        window_start: window.window_start,
        used: window.used + cost,
        ...(window.backoff_until === undefined ? {} : { backoff_until: window.backoff_until }),
      };
      const result = await this.store.casMeta(
        this.metaKey(),
        JSON.stringify(next),
        current === undefined ? null : current.rev,
      );
      if (result.status === "ok") return;
    }
    const message = "Swap provider API weight budget could not be reserved.";
    this.emitDenied({
      path,
      reason: "cas_conflict",
      message,
      used: 0,
      cost,
      gate,
      window_start: this.now(),
    });
    throw weightBudgetError(message);
  }

  /** Mark the shared window exhausted after the provider returns a rate-limit. */
  async markRateLimited(): Promise<void> {
    const now = this.now();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.store.getMeta(this.metaKey());
      const window = parseWeightWindow(current?.value, now);
      const next: WeightWindow = {
        window_start: window.window_start,
        used: Math.max(window.used, SWAP_PROVIDER_WEIGHT_SOFT_CAP),
        backoff_until: now + SWAP_PROVIDER_WEIGHT_BACKOFF_SECONDS,
      };
      const result = await this.store.casMeta(
        this.metaKey(),
        JSON.stringify(next),
        current === undefined ? null : current.rev,
      );
      if (result.status === "ok") return;
    }
  }

  private emitDenied(
    denial: Omit<SwapWeightBudgetDenial, "provider">,
  ): void {
    if (this.onDenied === undefined) return;
    try {
      this.onDenied({ provider: this.providerId, ...denial });
    } catch {
      // Diagnostics must never change payment or provider-call behavior.
    }
  }
}

/** @deprecated Use {@link SwapProviderWeightBudget}. */
export const FixedFloatWeightBudget = SwapProviderWeightBudget;

function parseWeightWindow(value: string | undefined, now: number): WeightWindow {
  if (value !== undefined) {
    try {
      const parsed = JSON.parse(value) as Partial<WeightWindow>;
      if (
        typeof parsed.window_start === "number" &&
        Number.isSafeInteger(parsed.window_start) &&
        typeof parsed.used === "number" &&
        Number.isSafeInteger(parsed.used) &&
        parsed.used >= 0 &&
        now - parsed.window_start < SWAP_PROVIDER_WEIGHT_WINDOW_SECONDS
      ) {
        return {
          window_start: parsed.window_start,
          used: parsed.used,
          ...(typeof parsed.backoff_until === "number" && Number.isSafeInteger(parsed.backoff_until)
            ? { backoff_until: parsed.backoff_until }
            : {}),
        };
      }
    } catch {
      // fall through to a fresh window
    }
  }
  return { window_start: now, used: 0 };
}

function weightBudgetError(message: string): Error & { readonly weightBudget: true } {
  const error = new Error(message) as Error & { readonly weightBudget: true };
  Object.defineProperty(error, "weightBudget", { value: true });
  return error;
}

export function isSwapProviderWeightBudgetError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "weightBudget" in error &&
    (error as { weightBudget?: unknown }).weightBudget === true
  );
}

/** @deprecated Use {@link isSwapProviderWeightBudgetError}. */
export const isFixedFloatWeightBudgetError = isSwapProviderWeightBudgetError;
