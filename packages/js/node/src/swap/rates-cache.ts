/**
 * Process-local key helpers and TTL defaults for the disposable swap-rates cache.
 */

/**
 * How often a warm rates blob is refreshed from the provider bulk feed.
 * Crypto pairs move fast; keep this short. The FixedFloat XML export is public
 * (no API key, no weight budget), so frequent refreshes are fine.
 */
export const SWAP_RATES_REFRESH_SECONDS = 15;

/**
 * Rates never serve past the fresh window on refresh failure — a dead feed must
 * fail closed so OpenReceive can fail over to the next configured provider.
 * Kept equal to {@link SWAP_RATES_REFRESH_SECONDS} for the cache API's required
 * maxStaleSeconds field; `serveStaleOnFailure: false` is what enforces fail-closed.
 */
export const SWAP_RATES_MAX_STALE_SECONDS = SWAP_RATES_REFRESH_SECONDS;

export type SwapRateType = "fixed" | "float";

/**
 * Process-local key for a provider's bulk rates snapshot.
 * Example: `swap_rates:fixedfloat:fixed`.
 */
export function swapRatesMetaKey(
  providerName: string,
  rateType: SwapRateType = "fixed",
): string {
  return `swap_rates:${providerName}:${rateType}`;
}
