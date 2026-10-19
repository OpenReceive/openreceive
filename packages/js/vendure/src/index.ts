// @openreceive/vendure: a Vendure plugin. Vendure loads it from
// @openreceive/vendure/plugin; this entry holds only the names a storefront
// or a test needs, and imports nothing from Vendure.

/** The payment method handler's code, the one a Vendure payment method picks in the dashboard. */
export const OPENRECEIVE_VENDURE_HANDLER_CODE = "openreceive";

/** Where the plugin mounts the checkout's routes on the Vendure server. */
export const OPENRECEIVE_VENDURE_ROUTE_PREFIX = "/openreceive";

/**
 * The route a storefront posts to, with the buyer's session, to start paying
 * the session's active order. It answers the order's `reference`.
 */
export const OPENRECEIVE_VENDURE_ORDER_ROUTE = `${OPENRECEIVE_VENDURE_ROUTE_PREFIX}/order`;

/** One payment's reference: an order, its currency, and what is due on it in Vendure's stored units. */
export interface OrderReference {
  readonly code: string;
  readonly currency: string;
  readonly due: number;
}

/**
 * The reference of a payment for a Vendure order: its code, its currency and
 * the amount due, as `<code>:<currency>:<due>`. A reference names a price that
 * never moves: when the cart changes, the amount due changes, and so does the
 * reference, so a checkout never resumes an invoice for an old total.
 */
export function orderReference(reference: OrderReference): string {
  return `${reference.code}:${reference.currency.toUpperCase()}:${reference.due}`;
}

/** The order code, currency and amount due a reference names, or undefined for anything else. */
export function parseOrderReference(reference: string): OrderReference | undefined {
  const match = /^(.+):([A-Z]{3}):(\d{1,15})$/.exec(reference);
  if (match === null) return undefined;
  const due = Number(match[3]);
  if (!Number.isSafeInteger(due) || due <= 0) return undefined;
  return { code: match[1] as string, currency: match[2] as string, due };
}
