import type { OpenReceiveCreateCheckoutAmount } from "./service.ts";

// Amount authority (PART 1 invariant + PART 2 seam).
//
// The shipped create-checkout route MUST NOT trust a client-supplied price. The host provides
// a `getOrderAmount` hook that returns the authoritative amount for an order; the route uses
// that, never the raw client amount. This mirrors the demo, where the cart total is computed
// server-side before OpenReceive is called. The route layer (@openreceive/http) merges the
// returned amount into the create request.

/** The amount source a client may send / a host may authoritatively return. Exactly one key. */
export type OpenReceiveCheckoutAmountSource =
  | { readonly amount: OpenReceiveCreateCheckoutAmount }
  | { readonly sats: number | string }
  | { readonly usd: string };

export interface OpenReceiveGetOrderAmountContext {
  /** The order the checkout belongs to. */
  readonly orderId: string;
  /** The amount the client sent — UNTRUSTED. Present only if the client sent one. */
  readonly clientAmount?: OpenReceiveCheckoutAmountSource;
  /** Metadata the client attached to the create request (untrusted). */
  readonly metadata?: Record<string, unknown>;
  /** The raw framework request, so the host can read its own cart/session/db. */
  readonly request: unknown;
}

/**
 * Host hook that returns the authoritative amount source for an order. The route builds the
 * final create-checkout request from this value, discarding any client-supplied price.
 */
export type OpenReceiveGetOrderAmount = (
  context: OpenReceiveGetOrderAmountContext,
) => OpenReceiveCheckoutAmountSource | Promise<OpenReceiveCheckoutAmountSource>;
