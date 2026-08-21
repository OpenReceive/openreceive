// Curated adapter surface: the @openreceive/http pieces a host wires an adapter
// with — the handler/stack factories, their options/context types, the error
// classes, and the generated wire body types. Host-integration internals (the
// SQL payment repository, reconcile gate, host factory plumbing) stay in
// @openreceive/http; import them from there when composing your own host.
// tools/validate/check-public-api.mjs pins this surface.
//
// @openreceive/express, @openreceive/fastify and @openreceive/next each are
// `export * from "@openreceive/http/adapter-surface"` — one list in one place
// instead of three identical copies that drift apart.
export type {
  Checkout,
  CheckoutCreatedHook,
  CheckoutCreatedInput,
  CreateCheckoutAmount,
  CreateOpenReceiveHttpHandlerOptions,
  CreateOpenReceiveStackOptions,
  OpenReceive,
  OpenReceiveAuthorize,
  OpenReceiveAuthorizeAction,
  OpenReceiveAuthorizeContext,
  OpenReceiveAuthorizeResource,
  OpenReceiveHost,
  OpenReceiveHttpHandler,
  OpenReceiveIpRateLimitConfig,
  OpenReceiveNotificationWorker,
  OpenReceiveOrderSettlement,
  OpenReceiveOrderSettlementHook,
  OpenReceivePaymentRepository,
  OpenReceiveRateLimit,
  OpenReceiveSettlementEvent,
  OpenReceiveSettlementEventHook,
  OpenReceiveStack,
  OpenReceiveWireCheckout,
  OpenReceiveWireCreateCheckoutRequest,
  OpenReceiveWireCreateCheckoutResponse,
  OpenReceiveWireCreateSwapRequest,
  OpenReceiveWireCreateSwapResponse,
  OpenReceiveWireError,
  OpenReceiveWireOrderRequest,
  OpenReceiveWirePaymentCheck,
  OpenReceiveWirePaymentCheckRequest,
  OpenReceiveWirePaymentStatus,
  OpenReceiveWirePrepareCheckoutRequest,
  OpenReceiveWirePrepareCheckoutResponse,
  OpenReceiveWireRefundSwapRequest,
  OpenReceiveWireSwapQuoteRequest,
  PaymentCheck,
  ResolveCheckoutContext,
  ResolveCheckoutHook,
  ResolvedHostCheckout,
  ServiceErrorShape,
  SwapCheckout,
} from "./index.ts";
export {
  createOpenReceiveHttpHandler,
  createOpenReceiveStack,
  hostError,
  isServiceErrorShape,
  mapHostRouteError,
  OpenReceiveHostError,
  OpenReceiveHttpError,
  startOpenReceiveNotificationWorker,
} from "./index.ts";
