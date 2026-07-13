// NWC client
export {
  OPENRECEIVE_NWC_METADATA_MAX_BYTES,
  OPENRECEIVE_NWC_CODE_HELP_URL,
  NWC_URI_PROTOCOL,
  NWC_REDACTED_SECRET,
  NwcUriParseError,
  formatOpenReceiveMissingNwcMessage,
  formatOpenReceiveInvalidNwcMessage,
  isTransactionSettled,
  parseNwcUri,
  parseNwcConnectionUri,
  redactNwcUri,
  redactNwcConnectionUri,
} from "./nwc/client.ts";
export type {
  NwcEncryptionMode,
  NwcUriParseErrorCode,
  OpenReceiveTransactionState,
  OpenReceiveWorkflowState,
  ParsedNwcConnection,
  WalletCapabilitySummary,
  MakeInvoiceRequest,
  MakeInvoiceResult,
  ListTransactionsRequest,
  NwcTransaction,
  ListTransactionsResult,
  OpenReceiveReceiveNwcClient,
  StandaloneNwcClient,
} from "./nwc/client.ts";

// Errors
export {
  OpenReceiveError,
  isOpenReceiveErrorCode,
  isRetryableOpenReceiveErrorCode,
} from "./errors/index.ts";
export type { OpenReceiveErrorCode, OpenReceiveErrorBody } from "./errors/index.ts";

// Exact integer/decimal money math (bigint — never binary floats)
export {
  OpenReceiveDecimalError,
  parseDecimal,
  formatDecimal,
  ceilDiv,
  formatBtcFromSats,
  multiplyAmount,
  sumAmounts,
  requiredBtcFiatRate,
  fiatValueToSats,
  satsToFiatValue,
  convertFiatViaBtcPrices,
  convertAmountViaBtcRates,
} from "./money/decimal.ts";
export type {
  OpenReceiveDecimal,
  OpenReceiveMoneyAmount,
  OpenReceiveBtcPriceRates,
} from "./money/decimal.ts";

// Rates — public quoting / provider surface (HTTP Simple Price helpers stay module-local)
export {
  OPENRECEIVE_PRICE_FEED_CACHE_SECONDS,
  OPENRECEIVE_INVOICE_QUOTE_TTL_SECONDS,
  OPENRECEIVE_PRICE_FEED_PRIMARY_TIMEOUT_MS,
  OPENRECEIVE_PRICE_SOURCE_IDS,
  OPENRECEIVE_STATIC_BTC_FIAT_RATES,
  OPENRECEIVE_PRICE_FEED_VS_CURRENCIES,
  OPENRECEIVE_PRIMARY_PRICE_FEED_URL,
  OPENRECEIVE_FALLBACK_PRICE_FEED_URL,
  OPENRECEIVE_PRICE_FEED_PRIMARY_URL_ENV,
  OPENRECEIVE_PRICE_FEED_FALLBACK_URL_ENV,
  OPENRECEIVE_SATS_PER_BTC,
  OPENRECEIVE_MSATS_PER_SAT,
  OPENRECEIVE_MIN_AMOUNT_SATS,
  OPENRECEIVE_MAX_AMOUNT_SATS,
  OPENRECEIVE_MIN_AMOUNT_MSATS,
  OPENRECEIVE_MAX_AMOUNT_MSATS,
  isOpenReceiveBitcoinAmountCurrency,
  quoteBitcoinAmountToMsats,
  getStaticBtcFiatPrice,
  quoteFiatValueToWholeSats,
  quoteFiatToMsatsWithPrice,
  quoteFiatToMsats,
  StaticPriceProvider,
  createCachedLivePriceFeed,
  CachedPriceFeed,
  isResolvedPriceProvider,
  isHealthCheckablePriceFeed,
  getBtcFiatRatesWithFallback,
  quoteFiatToMsatsWithProvider,
} from "./rates/index.ts";
export type {
  OpenReceivePriceSourceId,
  OpenReceiveLivePriceSourceId,
  OpenReceiveFiatAmount,
  OpenReceiveBitcoinAmount,
  OpenReceiveDirectAmountQuote,
  OpenReceiveRateQuote,
  QuoteFiatToMsatsRequest,
  QuoteFiatToMsatsWithPriceRequest,
  OpenReceiveBtcFiatRateMap,
  OpenReceivePriceProvider,
  OpenReceiveSourcedPriceProvider,
  OpenReceiveBtcFiatRateMapWithSource,
  SimplePriceFetch,
  OpenReceiveResolvedPriceProvider,
  OpenReceivePriceFeedHealthCheck,
  OpenReceivePriceFeedCacheStore,
  CachedPriceFeedOptions,
} from "./rates/index.ts";

// Settlement classification
export {
  getSettlementFinalitySignal,
  isTransactionExpired,
  isTransactionFailed,
  classifyTransactionSettlement,
} from "./settlement/index.ts";
export type {
  SettlementFinalitySignal,
  TransactionSettlementStatus,
  TransactionSettlementDetection,
} from "./settlement/index.ts";

// Storage / idempotency
export {
  IdempotencyConflictError,
  InvoiceStorageConflictError,
  InvoiceNotFoundError,
  idempotencyScopeKey,
  createIdempotencyRequestHash,
  canonicalJson,
  validateInvoiceStorageRow,
  cloneInvoiceStorageRow,
  isTerminalInvoiceStorageRow,
  readInvoiceStorageOrderId,
  readInvoiceStorageCheckoutId,
} from "./storage/index.ts";
export type {
  MaybePromise,
  OpenReceiveIdempotencyOperation,
  OpenReceiveSettlementActionState,
  OpenReceiveIdempotencyScope,
  InvoiceStorageRow,
} from "./storage/index.ts";
export {
  getIdempotentRecord,
  putCreatedInvoiceRecord,
  cloneStoredRecord,
  validateStoredRecord,
} from "./storage/kv.ts";
export type {
  StoredRecord,
  MetaRow,
  OpenReceiveKvConflictKey,
  OpenReceivePutIfAbsentResult,
  OpenReceiveInvoiceKvStore,
  PutCreatedInvoiceRecordOptions,
  PutCreatedInvoiceRecordResult,
} from "./storage/kv.ts";
export { InMemoryInvoiceKvStore } from "./storage/memory-kv.ts";

// Workflow state transitions
export {
  applySettled,
  applyExpiredClosed,
  applyFailedClosed,
  applyVerifying,
  applyExpiryPendingVerification,
  markTransactionScanAttempted,
  claimSettlementAction,
  clearSettlementActionClaim,
  applySettlementActionCompleted,
} from "./state/transitions.ts";

// Settlement runner
export {
  refreshStoredInvoiceStatus,
  refreshStoredInvoiceRecordsStatus,
  sweepPendingInvoicesOnce,
  runSettlementAction,
  createOpenReceiveReconciler,
} from "./runner/index.ts";
export type {
  OpenReceiveReconcileEventName,
  OpenReceiveReconcileEvent,
  OpenReceiveSettlementActionInput,
  OpenReceiveReconcileOptions,
  OpenReceiveStatusRefreshStatus,
  OpenReceiveStatusRefreshResult,
  OpenReceiveOrderStatusRefreshResult,
  OpenReceivePendingSweepReason,
  OpenReceivePendingSweepResult,
  OpenReceiveReconciler,
} from "./runner/index.ts";
