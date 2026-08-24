import { compact } from "@openreceive/core";

export const SWAP_PROVIDER_WEIGHT_WINDOW_SECONDS = 60;
export const SWAP_PROVIDER_WEIGHT_SOFT_CAP = 200;
export const SWAP_PROVIDER_CREATE_WEIGHT_GATE = 150;
export const SWAP_PROVIDER_CREATE_WEIGHT = 50;
export const SWAP_PROVIDER_DEFAULT_WEIGHT = 1;
export const SWAP_PROVIDER_WEIGHT_BACKOFF_SECONDS = 60;

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
}

/** Disposable per-process request guard; the provider remains global rate-limit authority. */
export class SwapProviderWeightBudget {
  #windowStart: number;
  #used = 0;
  #backoffUntil: number | undefined;

  constructor(
    private readonly providerId: string,
    private readonly now: () => number,
  ) {
    this.#windowStart = now();
  }

  weightForPath(path: string): number {
    return path === "create" ? SWAP_PROVIDER_CREATE_WEIGHT : SWAP_PROVIDER_DEFAULT_WEIGHT;
  }

  async reserve(path: string): Promise<void> {
    this.#rollWindow();
    const now = this.now();
    const cost = this.weightForPath(path);
    const gate = this.#gate(path);
    if (this.#backoffUntil !== undefined && this.#backoffUntil > now) {
      this.#deny(
        path,
        "backoff",
        cost,
        gate,
        `Swap provider API is in backoff until ${this.#backoffUntil}.`,
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
    this.#used += cost;
  }

  async markRateLimited(): Promise<void> {
    const now = this.now();
    this.#used = Math.max(this.#used, SWAP_PROVIDER_WEIGHT_SOFT_CAP);
    this.#backoffUntil = now + SWAP_PROVIDER_WEIGHT_BACKOFF_SECONDS;
  }

  // The weight window rolls; the 429 backoff does NOT ride along with it.
  // Clearing it here cut a backoff arbitrarily short — markRateLimited() at
  // second 59 of the window was forgiven one second later — so the backoff
  // expires on its own clock, checked in reserve().
  #rollWindow(): void {
    const now = this.now();
    if (now - this.#windowStart < SWAP_PROVIDER_WEIGHT_WINDOW_SECONDS) return;
    this.#windowStart = now;
    this.#used = 0;
  }

  #gate(path: string): number {
    return path === "create" ? SWAP_PROVIDER_CREATE_WEIGHT_GATE : SWAP_PROVIDER_WEIGHT_SOFT_CAP;
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
        backoff_until: this.#backoffUntil,
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
