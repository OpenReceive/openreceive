export type AuthorizeAction =
  | "checkout.prepare"
  | "checkout.create"
  | "payment.check"
  | "swap.quote"
  | "swap.create"
  | "swap.read"
  | "swap.refund";

/**
 * Copied from the payer's JSON body before any host lookup. `reference` is on
 * every order-scoped route; `paymentHash` is also set on `payment.check`,
 * `swap.read`, and `swap.refund`. Either value identifies a row — it does not
 * prove this caller owns it.
 */
export interface AuthorizeResource {
  reference?: string;
  paymentHash?: string;
}

export interface AuthorizeContext {
  readonly action: AuthorizeAction;
  readonly request: Request;
  readonly resource: AuthorizeResource;
  /**
   * The untouched framework-native request (Express req, Fastify request), when
   * an adapter provides one. Use it for middleware-attached state like
   * req.session. Same `authorize` callback as `request`; this is not a second
   * signature.
   */
  readonly native?: unknown;
}

/**
 * One callback, one argument. Return `true` to allow, `false` for 403.
 * May be sync or async. Destructure whichever fields of `context` you need —
 * they are always present except `native`, which adapters fill in.
 */
export type Authorize = (context: AuthorizeContext) => boolean | Promise<boolean>;

export type RateLimit = Authorize;
