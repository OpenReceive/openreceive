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
    private readonly onDenied?: (denial: SwapWeightBudgetDenial) => void,
  ) {
    this.#windowStart = now();
  }

  weightForPath(path: string): number {
    return path === "create" ? SWAP_PROVIDER_CREATE_WEIGHT : SWAP_PROVIDER_DEFAULT_WEIGHT;
  }

  async canReserve(path: string): Promise<boolean> {
    this.#rollWindow();
    const now = this.now();
    if (this.#backoffUntil !== undefined && this.#backoffUntil > now) return false;
    return this.#used + this.weightForPath(path) <= this.#gate(path);
  }

  async reserve(path: string): Promise<void> {
    this.#rollWindow();
    const now = this.now();
    const cost = this.weightForPath(path);
    const gate = this.#gate(path);
    if (this.#backoffUntil !== undefined && this.#backoffUntil > now) {
      this.#deny(path, "backoff", cost, gate, `Swap provider API is in backoff until ${this.#backoffUntil}.`);
    }
    if (this.#used + cost > gate) {
      this.#deny(path, "exhausted", cost, gate, `Swap provider API weight budget exhausted (${this.#used}+${cost} > ${gate}).`);
    }
    this.#used += cost;
  }

  async markRateLimited(): Promise<void> {
    const now = this.now();
    this.#used = Math.max(this.#used, SWAP_PROVIDER_WEIGHT_SOFT_CAP);
    this.#backoffUntil = now + SWAP_PROVIDER_WEIGHT_BACKOFF_SECONDS;
  }

  #rollWindow(): void {
    const now = this.now();
    if (now - this.#windowStart < SWAP_PROVIDER_WEIGHT_WINDOW_SECONDS) return;
    this.#windowStart = now;
    this.#used = 0;
    this.#backoffUntil = undefined;
  }

  #gate(path: string): number {
    return path === "create" ? SWAP_PROVIDER_CREATE_WEIGHT_GATE : SWAP_PROVIDER_WEIGHT_SOFT_CAP;
  }

  #deny(path: string, reason: SwapWeightBudgetDenialReason, cost: number, gate: number, message: string): never {
    try {
      this.onDenied?.({
        provider: this.providerId,
        path,
        reason,
        message,
        used: this.#used,
        cost,
        gate,
        window_start: this.#windowStart,
        ...(this.#backoffUntil === undefined ? {} : { backoff_until: this.#backoffUntil }),
      });
    } catch {
      // Diagnostics never affect provider behavior.
    }
    throw weightBudgetError(message);
  }
}

function weightBudgetError(message: string): Error & { readonly weightBudget: true } {
  const error = new Error(message) as Error & { readonly weightBudget: true };
  Object.defineProperty(error, "weightBudget", { value: true });
  return error;
}

export function isSwapProviderWeightBudgetError(error: unknown): boolean {
  return error instanceof Error && "weightBudget" in error && (error as { weightBudget?: unknown }).weightBudget === true;
}
