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
  Authorize,
  AuthorizeAction,
  AuthorizeContext,
  AuthorizeResource,
  Host,
  HttpHandler,
  IpRateLimitConfig,
  NotificationWorker,
  OrderSettlement,
  OrderSettlementHook,
  PaymentRepository,
  RateLimit,
  SettlementEvent,
  SettlementEventHook,
  Stack,
  StackStorage,
  StackWallet,
  WireCheckout,
  WireCreateCheckoutRequest,
  WireCreateCheckoutResponse,
  WireCreateSwapRequest,
  WireCreateSwapResponse,
  WireError,
  WireOrderRequest,
  WirePaymentCheck,
  WirePaymentCheckRequest,
  WirePaymentStatus,
  WirePrepareCheckoutRequest,
  WirePrepareCheckoutResponse,
  WireRefundSwapRequest,
  WireSwapQuoteRequest,
  PaymentCheck,
  ResolveCheckoutContext,
  ResolveCheckoutHook,
  ResolvedHostCheckout,
  ServiceErrorShape,
  SwapCheckout,
} from "./index.ts";
export {
  createHttpHandler,
  createStack,
  hostError,
  isServiceErrorShape,
  mapHostRouteError,
  HostError,
  HttpError,
  startNotificationWorker,
} from "./index.ts";
