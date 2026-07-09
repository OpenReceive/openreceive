import { openReceiveExpress } from "@openreceive/express";
import {
  guestCheckout,
  type OpenReceiveAuthorize,
  type OpenReceiveResolveAmount,
} from "@openreceive/http";
import type { OrderAccessTokenManager } from "@openreceive/node";
import type { Express } from "express";
import { resolveHelloFruitOrderAmount } from "../../../../shared/demo-order.ts";

// This module wires the SHIPPED OpenReceive routes into the demo instead of hand-writing them.
// It shows the whole re-architecture in one place: mount the router, keep the app's own auth via
// the `authorize` hook, keep prices honest via `resolveAmount`, and gate reads with per-order
// capability tokens. The demo's own `/prepare_order` still owns cart -> amount (that is the
// amount-authority example); these routes are the production-grade surface a real app would use.

type OpenReceiveService = Awaited<ReturnType<typeof import("@openreceive/node").createOpenReceive>>;

/**
 * TWO real authorize examples (spec PART 2), kept for the docs. The default mount below uses the
 * shipped `guestCheckout()` preset instead; these show what an equivalent hand-written policy — or a
 * user/account policy — looks like. Pick with OPENRECEIVE_DEMO_AUTHORIZE=guest|user.
 */

/**
 * Guest-checkout host (no accounts): anonymous checkout, reads gated only by the per-order capability token. This
 * is the hand-written equivalent of the shipped `guestCheckout()` preset — the preset builds on the
 * handler's precomputed `ctx.tokenValid`, so it needs no token manager of its own.
 */
export function helloFruitGuestCheckoutAuthorize(
  tokens: OrderAccessTokenManager,
): OpenReceiveAuthorize {
  return async ({ action, token, resource }) => {
    if (action === "checkout.create") return true; // anonymous checkout
    if (action === "invoice.sweep") return false; // privileged: fails closed for a guest-checkout site
    // Tier 2: the caller must hold this order's capability token.
    return resource.order_id !== undefined && (await tokens.verify(resource.order_id, token));
  };
}

/** User/account host: your own login owns the order. `getUser` reads YOUR session off the request. */
export function helloFruitUserSessionAuthorize(
  getUser: (request: unknown) => HelloFruitDemoUser | undefined,
): OpenReceiveAuthorize {
  return ({ action, request, resource }) => {
    const user = getUser(request);
    if (action === "checkout.create") return user !== undefined;
    if (action === "invoice.sweep") return user?.admin === true;
    // Tier 2: the order must belong to the signed-in user.
    return user !== undefined && orderBelongsToUser(user, resource.order_id);
  };
}

export interface HelloFruitDemoUser {
  readonly id: string;
  readonly admin?: boolean;
  readonly orderIds?: readonly string[];
}

function orderBelongsToUser(user: HelloFruitDemoUser, orderId?: string): boolean {
  if (orderId === undefined) return false;
  // Demo shape: a real app would query its DB. Here order ids embed the demo user id.
  return user.orderIds?.includes(orderId) ?? orderId.includes(user.id);
}

/** Example reader for the user-session authorize path (reads a demo header, not a real session). */
function demoUserFromRequest(request: unknown): HelloFruitDemoUser | undefined {
  const headers = (request as { headers?: { get?: (name: string) => string | null } }).headers;
  const id = headers?.get?.("x-demo-user") ?? undefined;
  return id === undefined || id.length === 0 ? undefined : { id, admin: id === "admin" };
}

/**
 * The amount-authority hook (spec PART 1/2). The client's price is NEVER trusted: `/prepare_order`
 * persisted the authoritative order under `demo_order:${orderId}`, so this just looks that order up
 * by id and returns its amount source.
 */
export function createHelloFruitResolveAmount(
  openreceive: OpenReceiveService,
): OpenReceiveResolveAmount {
  return ({ orderId }) => resolveHelloFruitOrderAmount(openreceive, orderId);
}

/** Mount the shipped OpenReceive routes at /openreceive with the demo's chosen auth + pricing. */
export function mountHelloFruitOpenReceiveRouter(
  app: Express,
  openreceive: OpenReceiveService,
  tokens: OrderAccessTokenManager,
): void {
  // Default to the shipped `guestCheckout()` preset (anonymous checkout, reads gated on the per-order
  // token, sweep denied). The two hand-written examples above stay exported for the docs; the
  // user-session one is still selectable with OPENRECEIVE_DEMO_AUTHORIZE=user.
  const authorize =
    process.env.OPENRECEIVE_DEMO_AUTHORIZE === "user"
      ? helloFruitUserSessionAuthorize(demoUserFromRequest)
      : guestCheckout();

  app.use(
    openReceiveExpress({
      service: openreceive,
      authorize,
      resolveAmount: createHelloFruitResolveAmount(openreceive),
      tokens,
    }),
  );
}
