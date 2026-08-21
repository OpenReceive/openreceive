/**
 * Route derivation for the mounted OpenReceive router.
 *
 * The browser is given one URL — the checkout's `orderUrl` — and derives every
 * other route from it. `orderUrl` IS the mounted `${prefix}/payments/check`
 * endpoint, so stripping that suffix yields the mount prefix that `/swaps`,
 * `/swaps/quote`, `/swaps/status` and `/swaps/refunds` hang off.
 */
export const OPENRECEIVE_PAYMENTS_CHECK_SUFFIX = "/payments/check";

/**
 * Mount prefix behind a checkout status URL. A URL that does not end in
 * `/payments/check` has no derivable route set: the prefix falls back to the URL
 * itself, and swap requests then hit a path the router does not serve.
 */
export function openReceiveRoutePrefix(orderUrl: string): string {
  const trimmed = orderUrl.replace(/\/+$/, "");
  return trimmed.endsWith(OPENRECEIVE_PAYMENTS_CHECK_SUFFIX)
    ? trimmed.slice(0, -OPENRECEIVE_PAYMENTS_CHECK_SUFFIX.length)
    : trimmed;
}
