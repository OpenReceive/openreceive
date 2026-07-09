// Authorization is layered by tier, mirroring rodauth-style route guards:
//   Tier 1 (public / payer-initiated writes): checkout.create, plus the open /rates read.
//   Tier 2 (per-order reads + payer swap actions): gated on a valid per-order capability token.
//   Tier 3 (admin): invoice.sweep — fails closed; the default policy always denies it.
// The host may override the whole policy with `authorize`; when it does not, `createDefaultAuthorize`
// enforces the token-based Tier-2 gate and the Tier-3 deny. The handler precomputes whether the
// presented token is valid for the resource's order and hands it to the policy as `ctx.tokenValid`,
// so policies (and the presets in `presets.ts`) never touch the token manager themselves.

/** The set of guarded actions a route can ask the host to authorize. */
export type OpenReceiveAuthorizeAction =
  | "checkout.create"
  | "order.read"
  | "checkout.read"
  | "swap.options"
  | "swap.quote"
  | "swap.start"
  | "swap.refund"
  | "swap.refresh"
  | "invoice.sweep";

/** The resource an action touches, filled in from the request path/body as far as it is known. */
export interface OpenReceiveAuthorizeResource {
  order_id?: string;
  checkout_id?: string;
  amount_msats?: number;
  attempt_id?: string;
}

/** The context handed to `authorize` / `rateLimit` for one guarded action. */
export interface OpenReceiveAuthorizeContext {
  readonly action: OpenReceiveAuthorizeAction;
  readonly request: Request;
  readonly resource: OpenReceiveAuthorizeResource;
  /** The raw capability token extracted from the request, or null if none was presented. */
  readonly token: string | null;
  /**
   * Whether `token` is a valid per-order capability token for `resource.order_id`, precomputed by
   * the handler against the token manager. False when no order id, no token, or the token does not
   * verify. Policies gate Tier-2 reads on this instead of touching the token manager themselves.
   */
  readonly tokenValid: boolean;
}

/** Host authorization hook. Return true to allow the action, false (or throw) to deny it (403). */
export type OpenReceiveAuthorize = (
  context: OpenReceiveAuthorizeContext,
) => boolean | Promise<boolean>;

/** Host rate-limit hook. Return true to allow the request, false to reject it with 429. */
export type OpenReceiveRateLimit = (
  context: OpenReceiveAuthorizeContext,
) => boolean | Promise<boolean>;

/**
 * The built-in policy used when the host does not supply `authorize`. Tier 1 (checkout.create, and
 * the public /rates read that never reaches authorize) is open, Tier 2 requires a valid per-order
 * token — surfaced by the handler as `ctx.tokenValid` — and Tier 3 (invoice.sweep) is denied. It no
 * longer needs the token manager: the handler precomputes token validity before calling authorize.
 */
export function createDefaultAuthorize(): OpenReceiveAuthorize {
  return (ctx: OpenReceiveAuthorizeContext): boolean =>
    ctx.action === "checkout.create"
      ? true
      : ctx.action === "invoice.sweep"
        ? false
        : ctx.tokenValid;
}
