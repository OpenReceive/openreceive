export type OpenReceiveAuthorizeAction =
  | "checkout.prepare"
  | "checkout.create"
  | "payment.check"
  | "swap.quote"
  | "swap.create"
  | "swap.read"
  | "swap.refund";

export interface OpenReceiveAuthorizeResource {
  order_id?: string;
  payment_hash?: string;
}

export interface OpenReceiveAuthorizeContext {
  readonly action: OpenReceiveAuthorizeAction;
  readonly request: Request;
  readonly resource: OpenReceiveAuthorizeResource;
  /**
   * The untouched framework-native request (Express req, Fastify request), when
   * an adapter provides one. Use it for middleware-attached state like
   * req.session.
   */
  readonly native?: unknown;
}

export type OpenReceiveAuthorize = (
  context: OpenReceiveAuthorizeContext,
) => boolean | Promise<boolean>;

export type OpenReceiveRateLimit = OpenReceiveAuthorize;
