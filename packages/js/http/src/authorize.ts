export type OpenReceiveAuthorizeAction =
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
}

export type OpenReceiveAuthorize = (
  context: OpenReceiveAuthorizeContext,
) => boolean | Promise<boolean>;

export type OpenReceiveRateLimit = OpenReceiveAuthorize;
