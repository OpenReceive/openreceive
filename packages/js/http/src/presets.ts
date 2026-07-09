import type { OpenReceiveAuthorize, OpenReceiveAuthorizeContext } from "./authorize.ts";

// Ready-made `authorize` policies for the two common host shapes. Both build on `ctx.tokenValid` —
// the per-order token validity the handler precomputes — so neither needs the token manager, a
// session store, or any manager wiring. Pass one as `authorize` to `createOpenReceiveHttpHandler`.

/** Options for {@link guestCheckout}. */
export interface GuestCheckoutOptions {
  /**
   * Gate for the Tier-3 `invoice.sweep` admin action (denied by default). Return true to allow —
   * e.g. after checking a shared admin secret on the request. Omit to keep sweep closed.
   */
  readonly allowSweep?: (ctx: OpenReceiveAuthorizeContext) => boolean | Promise<boolean>;
}

/**
 * Policy for an guest-checkout site (no accounts) / paywall: anyone may create a checkout, per-order reads and
 * swap actions are gated on the order's capability token (the httpOnly cookie set on create is
 * enough), and admin sweep is denied unless `allowSweep` opts in.
 */
export function guestCheckout(options?: GuestCheckoutOptions): OpenReceiveAuthorize {
  return async (ctx: OpenReceiveAuthorizeContext): Promise<boolean> => {
    if (ctx.action === "checkout.create") {
      return true;
    }
    if (ctx.action === "invoice.sweep") {
      return (await options?.allowSweep?.(ctx)) ?? false;
    }
    return ctx.tokenValid;
  };
}

/** Options for {@link withUser}. */
export interface WithUserOptions<U> {
  /**
   * Whether `user` owns the order named in `ctx.resource.order_id` (a DB lookup, typically). When
   * omitted, ownership falls back to `ctx.tokenValid`, so a logged-in user who also holds the order
   * token is allowed.
   */
  readonly ownsOrder?: (user: U, ctx: OpenReceiveAuthorizeContext) => boolean | Promise<boolean>;
  /** Whether `user` may run the Tier-3 `invoice.sweep` admin action. Denied when omitted. */
  readonly isAdmin?: (user: U) => boolean;
}

/**
 * Policy for a site with logged-in users: `getUser` resolves the request's user (e.g. from a
 * session). A missing user is denied everything; a present user may always create a checkout, may
 * sweep only when `isAdmin` allows, and may read/act on an order per `ownsOrder` (falling back to
 * the order token via `ctx.tokenValid` when `ownsOrder` is not supplied).
 */
export function withUser<U>(
  getUser: (request: Request) => U | undefined | Promise<U | undefined>,
  options?: WithUserOptions<U>,
): OpenReceiveAuthorize {
  return async (ctx: OpenReceiveAuthorizeContext): Promise<boolean> => {
    const user = await getUser(ctx.request);
    if (!user) {
      return false;
    }
    if (ctx.action === "checkout.create") {
      return true;
    }
    if (ctx.action === "invoice.sweep") {
      return options?.isAdmin?.(user) ?? false;
    }
    return options?.ownsOrder ? await options.ownsOrder(user, ctx) : ctx.tokenValid;
  };
}
