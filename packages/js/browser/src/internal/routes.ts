/**
 * Route derivation for the mounted OpenReceive router.
 *
 * The browser is given ONE thing — `prefix`, the base path the shipped router
 * is mounted at — and derives every route it calls from it. They are one set on
 * purpose: the create route, the prepare route, the payment-check status route
 * and the four swap routes all belong to the same mount, so a checkout cannot
 * be created against one deployment and settled against another. That is why
 * there is no per-route override, and why `prefix` is the only URL concept the
 * browser packages accept.
 *
 * A trailing slash on the prefix is stripped; `""` means "mounted at the root".
 */
export interface OpenReceiveRoutes {
  /** POST: mint (or reuse) a Lightning attempt for an order. */
  readonly checkouts: string;
  /** POST: lock the order amount and load payment methods without minting. */
  readonly checkoutsPrepare: string;
  /** POST: the payer-facing status read for the displayed attempt. */
  readonly paymentsCheck: string;
  /** POST: start a swap deposit attempt for a pay-in asset. */
  readonly swaps: string;
  /** POST: quote a pay-in asset before starting a swap. */
  readonly swapsQuote: string;
  /** POST: the swap provider's live state for one attempt. */
  readonly swapsStatus: string;
  /** POST: review or confirm a refund for one swap attempt. */
  readonly swapsRefunds: string;
}

/**
 * Every route the browser calls, derived from the router's mount prefix.
 *
 * THE INVARIANT, and why this throws instead of defaulting: THERE IS ONE
 * MOUNT. Every route below comes from this one string, so quietly substituting
 * a default for a `prefix` that never arrived would split the flow across
 * DIFFERENT deployments — a checkout created against one host, then prepared,
 * polled, swapped and refunded against another. That is a lost payment, not a
 * cosmetic bug, and it surfaces long after the mistake. Fail loudly here, at
 * the one derivation, before the first request goes out.
 *
 * This is the last guard on the path: `requestCheckout` / `prepareCheckout`
 * (main entry), `createOpenReceiveStatusFetcher` and the swap calls (./headless
 * and ./internal) all funnel through this function, so checking here covers
 * every published entry point at once and leaves no copy to drift.
 *
 * NOT REDUNDANT WITH THE TYPES — do not delete it as such. `prefix` is
 * REQUIRED in every options type that carries it, so a TypeScript caller never
 * reaches this throw. It is here for the callers the types do not reach: plain
 * JavaScript integrations, a wrapper handing through an attribute or prop that
 * was never set, and any value that only turns out to be `undefined` at run
 * time. Without it those callers get a `TypeError` from `.replace` on
 * `undefined`, which names neither the option nor the fix.
 */
export function openReceiveRoutes(prefix: string): OpenReceiveRoutes {
  if (typeof prefix !== "string") {
    throw new TypeError(
      "OpenReceive requires `prefix`, the base path the shipped router is mounted at " +
        `(for example "/openreceive"); every checkout, status and swap route is derived ` +
        `from it. Received ${prefix === null ? "null" : typeof prefix}.`,
    );
  }
  const base = prefix.replace(/\/+$/, "");
  return {
    checkouts: `${base}/checkouts`,
    checkoutsPrepare: `${base}/checkouts/prepare`,
    paymentsCheck: `${base}/payments/check`,
    swaps: `${base}/swaps`,
    swapsQuote: `${base}/swaps/quote`,
    swapsStatus: `${base}/swaps/status`,
    swapsRefunds: `${base}/swaps/refunds`,
  };
}
