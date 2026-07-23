export type OpenReceiveAuthorizeAction =
  | "checkout.create"
  | "payment.check"
  | "swap.quote"
  | "swap.create"
  | "swap.read"
  | "swap.refund.confirm"
  | "swap.refund";

export interface OpenReceiveAuthorizeResource {
  order_id?: string;
  payment_hash?: string;
  recovery_token_present?: boolean;
}

export interface OpenReceiveAuthorizeContext {
  readonly action: OpenReceiveAuthorizeAction;
  readonly request: Request;
  readonly resource: OpenReceiveAuthorizeResource;
  readonly token: string | null;
  readonly tokenValid: boolean;
}

export type OpenReceiveAuthorize = (
  context: OpenReceiveAuthorizeContext,
) => boolean | Promise<boolean>;

export type OpenReceiveRateLimit = OpenReceiveAuthorize;

/** Checkout creation and quotes are public; payment/swap state requires capability or host auth. */
export function createDefaultAuthorize(): OpenReceiveAuthorize {
  return (context) =>
    context.action === "checkout.create" ||
    context.action === "swap.quote" ||
    context.action === "swap.create" ||
    context.tokenValid;
}
