// @openreceive/http — the framework-agnostic HTTP handler at the heart of the route-shipping
// re-architecture. It exposes rodauth-style routes over a host-provided OpenReceive `service`
// (which owns the host's DB + wallet) as a single Web-standard Fetch handler. Auth, pricing, and
// rate limiting stay the host's, injected as hooks. Any runtime with Fetch `Request`/`Response`
// (Node 20+, Deno, Bun, edge) can mount it; framework adapters wrap this one handler.

// Re-exported host-facing types so adapters can type their glue without also depending on
// @openreceive/node directly.
export type {
  OpenReceive,
  OpenReceiveCheckout,
  OpenReceiveCheckoutAmountSource,
  OpenReceiveOrderStatus,
  OpenReceiveGetOrderAmount,
  OpenReceiveGetOrderAmountContext,
  OpenReceiveResolveOrder,
  OpenReceiveResolveOrderContext,
} from "@openreceive/node";
export {
  createDefaultAuthorize,
  type OpenReceiveAuthorize,
  type OpenReceiveAuthorizeAction,
  type OpenReceiveAuthorizeContext,
  type OpenReceiveAuthorizeResource,
  type OpenReceiveRateLimit,
} from "./authorize.ts";
export { OpenReceiveHttpError } from "./errors.ts";
export {
  type CreateOpenReceiveHttpHandlerOptions,
  createOpenReceiveHttpHandler,
  extractToken,
  type OpenReceiveHttpHandler,
  ORDER_TOKEN_COOKIE_NAME,
} from "./handler.ts";
export {
  type GuestCheckoutOptions,
  guestCheckout,
  type WithUserOptions,
  withUser,
} from "./presets.ts";
export type {
  OrderAccessTokenManager,
  OrderAccessTokenManagerOptions,
  OrderAccessTokenMintResult,
} from "./tokens.ts";
export { createOrderAccessTokenManager } from "./tokens.ts";
