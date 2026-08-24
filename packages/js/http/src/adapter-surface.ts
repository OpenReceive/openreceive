// Curated adapter surface: the @openreceive/http pieces a host wires an adapter
// with — the handler/stack factories, their options/context types, and the
// error classes.
//
// The generated Wire* request/response body types are deliberately NOT here.
// An adapter host names the factory, its options, and the hooks; it never
// constructs a wire body — the handler owns that side. They stay importable
// from @openreceive/http for the rare host that types a proxy.
//
// Host-integration internals (the SQL payment repository, reconcile gate, host
// factory plumbing) stay in @openreceive/http too; import them from there when
// composing your own host.
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
  CreateHttpHandlerOptions,
  CreateStackOptions,
  OpenReceive,
  Authorize,
  AuthorizeAction,
  AuthorizeContext,
  AuthorizeResource,
  Host,
  HttpHandler,
  IpRateLimitConfig,
  NotificationWorker,
  PaymentSettlement,
  PaymentSettlementHook,
  PaymentRepository,
  RateLimit,
  SettlementEvent,
  SettlementEventHook,
  Stack,
  StackStorage,
  StackWallet,
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
