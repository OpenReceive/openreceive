export type {
  Checkout,
  CreateCheckoutAmount,
  OpenReceive,
  PaymentCheck,
  SwapCheckout,
} from "@openreceive/node";
export type { OpenReceiveNodeRequestParts } from "./adapter-bridge.ts";
// Generated snake_case wire body types for the HTTP contract.
export type * from "./generated/wire.ts";
export { openReceiveIsUnderPrefix, openReceiveWebRequest } from "./adapter-bridge.ts";
export type {
  OpenReceiveAuthorize,
  OpenReceiveAuthorizeAction,
  OpenReceiveAuthorizeContext,
  OpenReceiveAuthorizeResource,
  OpenReceiveRateLimit,
} from "./authorize.ts";
export type { ServiceErrorShape } from "./errors.ts";
export {
  createRequestId,
  errorResponse,
  hostError,
  isServiceErrorShape,
  jsonResponse,
  mapHostRouteError,
  OpenReceiveHostError,
  OpenReceiveHttpError,
} from "./errors.ts";
export type {
  CheckoutCreatedHook,
  CheckoutCreatedInput,
  CreateOpenReceiveHttpHandlerOptions,
  OpenReceiveHttpHandler,
  ResolveCheckoutContext,
  ResolveCheckoutHook,
  ResolvedHostCheckout,
} from "./handler.ts";
export { createOpenReceiveHttpHandler } from "./handler.ts";
export type {
  CreateOpenReceiveHostDbOptions,
  CreateOpenReceiveHostOptions,
  CreateOpenReceiveHostRepositoryOptions,
  OpenReceiveHost,
  OpenReceiveSettlementEvent,
  OpenReceiveSettlementEventHook,
} from "./host-payments.ts";
export { createOpenReceiveHost } from "./host-payments.ts";
export type {
  OpenReceiveAttemptStatus,
  OpenReceivePaymentInsert,
  OpenReceivePaymentRecord,
  OpenReceivePaymentRepository,
  OpenReceiveReconcilableAttempt,
  OpenReceiveReconciliationTransition,
  OpenReceiveSettlementRecord,
} from "./payment-repository.ts";
// The attempt decision machinery (liveAttemptCommitDecision,
// isReusablePaymentAttempt, reconciliationTransition) is deliberately NOT
// exported: hosts see "unpaid or paid", never the live/supersede vocabulary.
// Custom repositories import the contract types below and implement against
// the documented invariants instead.
export {
  OPENRECEIVE_ATTEMPT_EXPIRY_GRACE_SECONDS,
  OPENRECEIVE_ATTEMPT_REUSE_BUFFER_SECONDS,
  openReceivePaymentInsert,
} from "./payment-repository.ts";
export type { OpenReceiveReconciler } from "./reconcile-loop.ts";
export { reconcileOpenReceivePayments, startOpenReceiveReconciler } from "./reconcile-loop.ts";
export type {
  OpenReceiveNotificationListener,
  OpenReceiveNotificationWorker,
} from "./notifications.ts";
export {
  startOpenReceiveNotificationListener,
  startOpenReceiveNotificationWorker,
} from "./notifications.ts";
export type {
  MaybeReconcileOpenReceivePaymentsOptions,
  OpenReceiveOpportunisticReconcileResult,
} from "./reconcile-gate.ts";
export {
  maybeReconcileOpenReceivePayments,
  OPENRECEIVE_MIN_RECONCILE_INTERVAL_SECONDS,
  OPENRECEIVE_RECONCILE_SCAN_MAX_PAGES,
  OPENRECEIVE_RECONCILE_SCAN_TIMEOUT_MS,
  openReceiveReconcileIntervalSeconds,
} from "./reconcile-gate.ts";
export type { OpenReceiveIpRateLimitConfig } from "./rate-limit.ts";
export {
  createOpenReceiveIpRateLimit,
  createProxyRateLimitingConfig,
  OPENRECEIVE_DEFAULT_IP_RATE_LIMIT_PER_HOUR,
  openReceiveClientIp,
  openReceiveClientIpBucket,
} from "./rate-limit.ts";
export type {
  OpenReceiveSqlAdapter,
  OpenReceiveSqlClient,
  OpenReceiveSqlDatabase,
  OpenReceiveSqlQuery,
} from "./sql-adapters.ts";
export { resolveSqlAdapter } from "./sql-adapters.ts";
export type {
  OpenReceiveOrderSettlement,
  OpenReceiveOrderSettlementHook,
  OpenReceiveSqlPaymentRepository,
  OpenReceiveSqlPaymentsOptions,
} from "./sql-payments.ts";
export {
  createOpenReceiveSqlPayments,
  OPENRECEIVE_PAYMENTS_SCHEMA_VERSION,
  OPENRECEIVE_RECONCILE_BATCH_SIZE,
  openReceivePaymentsSchemaSql,
} from "./sql-payments.ts";
export type { CreateOpenReceiveStackOptions, OpenReceiveStack } from "./stack.ts";
export { createOpenReceiveStack, isOpenReceiveStackOptions } from "./stack.ts";
