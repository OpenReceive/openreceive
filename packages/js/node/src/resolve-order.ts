import type { OpenReceiveCreateCheckoutAmount } from "./service.ts";

// Amount authority.
//
// The shipped create-checkout route MUST NOT trust a client-supplied price. The host provides
// a `resolveOrder` hook that loads the host's order and returns its payment terms; the route
// uses that, never a raw client amount. This mirrors the demo, where the cart total is computed
// server-side before OpenReceive is called. The route layer (@openreceive/http) merges the
// returned amount into the create request.
//
// Omitting the hook is a construction error. The HTTP create body never carries a price
// (amount/sats/usd are rejected). Client-priced / tip-jar checkouts remain possible: the host
// reads a payer-chosen amount from `metadata` (or its own session) inside `resolveOrder`,
// validates it, and returns it — an explicit host-owned decision, not a framework default.

/** The amount source a client may send / a host may authoritatively return. Exactly one key. */
export type OpenReceiveCheckoutAmountSource =
  | { readonly amount: OpenReceiveCreateCheckoutAmount }
  | { readonly sats: number | string }
  | { readonly usd: string };

export interface OpenReceiveResolveOrderContext {
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
 * Host hook that loads the host's order and returns its payment terms. The route builds the
 * final create-checkout request from this value, discarding any client-supplied price unless
 * the host explicitly returns it.
 *
 * - return `{ usd }` | `{ sats }` | `{ amount: {...} }` → authoritative price
 * - return `null` → 404 (order not found / rejected)
 * - throw → 400 (validation)
 */
export type OpenReceiveResolveOrder = (
  context: OpenReceiveResolveOrderContext,
) =>
  | OpenReceiveCheckoutAmountSource
  | null
  | Promise<OpenReceiveCheckoutAmountSource | null>;

/** @deprecated Use {@link OpenReceiveResolveOrderContext}. */
export type OpenReceiveGetOrderAmountContext = OpenReceiveResolveOrderContext;

/** @deprecated Use {@link OpenReceiveResolveOrder}. */
export type OpenReceiveGetOrderAmount = OpenReceiveResolveOrder;
