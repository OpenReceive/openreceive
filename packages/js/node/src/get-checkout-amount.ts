/**
 * Amount-authority types historically used when hosts wired create-checkout pricing directly.
 * Prefer the shipped POST /prepare + `prepareCheckout` hook on `@openreceive/http`.
 */

import type { CreateCheckoutAmount } from "./service.ts";

/** Authoritative amount shape persisted by prepare and read by create-checkout. */
export type CheckoutAmountSource = {
  readonly amount: CreateCheckoutAmount;
};

/** @deprecated Prefer `prepareCheckout` on the HTTP mount. */
export interface GetCheckoutAmountContext {
  readonly orderId: string;
  readonly metadata?: Record<string, unknown>;
  readonly request: unknown;
}

/** @deprecated Prefer `prepareCheckout` on the HTTP mount. */
export type GetCheckoutAmount = (
  context: GetCheckoutAmountContext,
) => CheckoutAmountSource | null | Promise<CheckoutAmountSource | null>;

/** @deprecated Use {@link GetCheckoutAmountContext}. */
export type ResolveOrderContext = GetCheckoutAmountContext;

/** @deprecated Use {@link GetCheckoutAmount}. */
export type ResolveOrder = GetCheckoutAmount;

/** @deprecated Use {@link GetCheckoutAmountContext}. */
export type GetOrderAmountContext = GetCheckoutAmountContext;

/** @deprecated Use {@link GetCheckoutAmount}. */
export type GetOrderAmount = GetCheckoutAmount;
