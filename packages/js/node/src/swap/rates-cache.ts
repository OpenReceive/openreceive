/**
 * Meta-key helpers and TTL defaults for the durable global swap-rates cache.
 *
 * Rates live in `openreceive_meta` (same KV as fiat price feed and `/ccies`
 * limits) — not a separate SQL table. One blob per provider + rate type is
 * shared across every checkout and process via {@link StoreBackedSwapCache}.
 */

/**
 * How often a warm rates blob is refreshed from the provider bulk feed.
 * Crypto pairs move fast; keep this short. The FixedFloat XML export is public
 * (no API key, no weight budget), so frequent global refreshes are fine.
 */
export const SWAP_RATES_REFRESH_SECONDS = 15;

/**
 * How long a stale rates blob may still be served when a refresh fails.
 * Past this window a failing provider surfaces the error instead of stale rates.
 * Kept only slightly above the fresh window so a brief outage does not freeze
 * an outdated crypto quote on the pay screen.
 */
export const SWAP_RATES_MAX_STALE_SECONDS = 60;

export type SwapRateType = "fixed" | "float";

/**
 * Durable meta key for a provider's bulk rates snapshot.
 * Example: `swap_rates:fixedfloat:fixed`.
 */
export function swapRatesMetaKey(
  providerName: string,
  rateType: SwapRateType = "fixed",
): string {
  return `swap_rates:${providerName}:${rateType}`;
}
