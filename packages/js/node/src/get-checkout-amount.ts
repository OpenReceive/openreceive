import type { CreateCheckoutAmount } from "./service.ts";

// Amount authority.
//
// The shipped create-checkout route MUST NOT trust a client-supplied price. The host provides
// a `getCheckoutAmount` hook that returns the payment terms for an order; the route uses that,
// never a raw client amount. This runs only on POST create-checkout — not on GET order status.
//
// Omitting the hook is a construction error. The HTTP create body never carries a price
// (amount is rejected). Client-priced / tip-jar checkouts remain possible: the host
// reads a payer-chosen amount from `metadata` (or its own session) inside `getCheckoutAmount`,
// validates it, and returns it — an explicit host-owned decision, not a framework default.

/** The amount a host may authoritatively return from `getCheckoutAmount`. */
export type CheckoutAmountSource = {
  readonly amount: CreateCheckoutAmount;
};

export interface GetCheckoutAmountContext {
  /** The order the checkout belongs to. */
  readonly orderId: string;
  /** Metadata the client attached to the create request (untrusted). */
  readonly metadata?: Record<string, unknown>;
  /** The raw framework request, so the host can read its own cart/session/db. */
  readonly request: unknown;
}

/**
 * Host hook that returns the payment terms for creating a checkout. Called only by
 * POST create-checkout — never by GET order status. The route builds the final
 * create-checkout request from this value; client-supplied prices are rejected.
 *
 * - return `{ amount: { currency, value } }` or `{ amount: { sats } }` → authoritative price
 * - return `null` → 404 (order not found / rejected)
 * - throw → 400 (validation)
 */
export type GetCheckoutAmount = (
  context: GetCheckoutAmountContext,
) =>
  | CheckoutAmountSource
  | null
  | Promise<CheckoutAmountSource | null>;

/** @deprecated Use {@link GetCheckoutAmountContext}. */
export type ResolveOrderContext = GetCheckoutAmountContext;

/** @deprecated Use {@link GetCheckoutAmount}. */
export type ResolveOrder = GetCheckoutAmount;

/** @deprecated Use {@link GetCheckoutAmountContext}. */
export type GetOrderAmountContext = GetCheckoutAmountContext;

/** @deprecated Use {@link GetCheckoutAmount}. */
export type GetOrderAmount = GetCheckoutAmount;
