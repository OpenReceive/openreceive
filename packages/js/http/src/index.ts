export type {
  Checkout,
  CreateCheckoutAmount,
  OpenReceive,
  PaymentCheck,
  SwapCheckout,
} from "@openreceive/node";
export type { NodeRequestParts } from "./adapter-bridge.ts";
// Generated snake_case wire body types for the HTTP contract.
export type * from "./generated/wire.ts";
export { isUnderPrefix, webRequest } from "./adapter-bridge.ts";
export type {
  Authorize,
  AuthorizeAction,
  AuthorizeContext,
  AuthorizeResource,
  RateLimit,
} from "./authorize.ts";
export type { ServiceErrorShape } from "./errors.ts";
export {
  createRequestId,
  errorResponse,
  hostError,
  isServiceErrorShape,
  jsonResponse,
  mapHostRouteError,
  HostError,
  HttpError,
} from "./errors.ts";
export type {
  CheckoutCreatedHook,
  CheckoutCreatedInput,
  CreateOpenReceiveHttpHandlerOptions,
  HttpHandler,
  ResolveCheckoutContext,
  ResolveCheckoutHook,
  ResolvedHostCheckout,
} from "./handler.ts";
export { createHttpHandler } from "./handler.ts";
export type {
  CreateOpenReceiveHostDbOptions,
  CreateOpenReceiveHostOptions,
  CreateOpenReceiveHostRepositoryOptions,
  Host,
  SettlementEvent,
  SettlementEventHook,
} from "./host-payments.ts";
export { createHost } from "./host-payments.ts";
export type {
  AttemptStatus,
  PaymentInsert,
  PaymentRecord,
  PaymentRepository,
  ReconcilableAttempt,
  ReconciliationTransition,
  SettlementRecord,
} from "./payment-repository.ts";
// The attempt decision machinery (liveAttemptCommitDecision,
// isReusablePaymentAttempt, reconciliationTransition) is deliberately NOT
// exported: hosts see "unpaid or paid", never the live/supersede vocabulary.
// Custom repositories import the contract types below and implement against
// the documented invariants instead.
export { OPENRECEIVE_ATTEMPT_EXPIRY_GRACE_SECONDS } from "./payment-repository.ts";
export type { Reconciler } from "./reconcile-loop.ts";
export { reconcileHostPayments, startReconciler } from "./reconcile-loop.ts";
export type {
  NotificationListener,
  NotificationWorker,
} from "./notifications.ts";
export {
  startNotificationListener,
  startNotificationWorker,
} from "./notifications.ts";
export type {
  MaybeReconcileOpenReceivePaymentsOptions,
  OpportunisticReconcileResult,
} from "./reconcile-gate.ts";
export {
  maybeReconcilePayments,
  OPENRECEIVE_MIN_RECONCILE_INTERVAL_SECONDS,
  OPENRECEIVE_RECONCILE_SCAN_MAX_PAGES,
  OPENRECEIVE_RECONCILE_SCAN_TIMEOUT_MS,
  reconcileIntervalSeconds,
} from "./reconcile-gate.ts";
export type { IpRateLimitConfig } from "./rate-limit.ts";
export {
  createIpRateLimit,
  createProxyRateLimitingConfig,
  resolveClientIp,
} from "./rate-limit.ts";
export type {
  SqlAdapter,
  SqlClient,
  SqlDatabase,
  SqlQuery,
} from "./sql-adapters.ts";
export type { KnexLike, PrismaLike, SqlDialect, TypeOrmLike } from "./orm-adapters.ts";
export { knexDb, prismaDb, typeOrmDb } from "./orm-adapters.ts";
export type {
  PaymentSettlement,
  PaymentSettlementHook,
  SqlPaymentRepository,
  SqlPaymentsOptions,
} from "./sql-payments.ts";
export {
  createSqlPayments,
  OPENRECEIVE_PAYMENTS_SCHEMA_VERSION,
  OPENRECEIVE_RECONCILE_BATCH_SIZE,
  paymentsSchemaSql,
} from "./sql-payments.ts";
export type {
  CreateOpenReceiveStackOptions,
  Stack,
  StackStorage,
  StackWallet,
} from "./stack.ts";
export { createStack, isStackOptions } from "./stack.ts";
