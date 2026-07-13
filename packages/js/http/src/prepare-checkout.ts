import type { CreateCheckoutAmount } from "@openreceive/node";

/**
 * Result of the host `prepareCheckout` hook. OpenReceive persists `amount` as create-checkout
 * price authority and optionally stores `summary` for `GET …/orders/{id}/summary`.
 */
export interface PrepareCheckoutResult {
  /** Authoritative payment terms for a later POST /checkouts. */
  readonly amount: CreateCheckoutAmount;
  /** Host order id. When omitted, OpenReceive mints a UUID. */
  readonly orderId?: string;
  /** Opaque display payload returned by the order-summary route (guest resume UI). */
  readonly summary?: unknown;
  /** Optional metadata stored with the prepared order. */
  readonly metadata?: Record<string, unknown>;
}

export interface PrepareCheckoutContext {
  /** Parsed JSON body from POST /prepare (untrusted). */
  readonly body: unknown;
  /** The raw framework request. */
  readonly request: Request;
}

/**
 * Host hook for POST /prepare. Validates cart / looks up orders, returns the authoritative
 * amount (and optional summary). Return `null` → 404; throw → 400.
 */
export type PrepareCheckout = (
  context: PrepareCheckoutContext,
) => PrepareCheckoutResult | null | Promise<PrepareCheckoutResult | null>;
