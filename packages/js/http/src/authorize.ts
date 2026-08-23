export type AuthorizeAction =
  | "checkout.prepare"
  | "checkout.create"
  | "payment.check"
  | "swap.quote"
  | "swap.create"
  | "swap.read"
  | "swap.refund";

export interface AuthorizeResource {
  orderId?: string;
  paymentHash?: string;
}

export interface AuthorizeContext {
  readonly action: AuthorizeAction;
  readonly request: Request;
  readonly resource: AuthorizeResource;
  /**
   * The untouched framework-native request (Express req, Fastify request), when
   * an adapter provides one. Use it for middleware-attached state like
   * req.session.
   */
  readonly native?: unknown;
}

export type Authorize = (context: AuthorizeContext) => boolean | Promise<boolean>;

export type RateLimit = Authorize;
