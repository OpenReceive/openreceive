// NWC client

export type { OpenReceiveErrorBody, OpenReceiveErrorCode } from "./errors/index.ts";
// Errors
export {
  isOpenReceiveErrorCode,
  isRetryableOpenReceiveErrorCode,
  OpenReceiveError,
} from "./errors/index.ts";
export type {
  OpenReceiveBitcoinAmount,
  OpenReceiveBtcFiatRateMap,
  OpenReceiveDecimal,
  OpenReceiveFiatAmount,
} from "./money/decimal.ts";
// Exact integer/decimal money math (bigint — never binary floats). The one
// decimal engine: rate quoting and the Node swap providers parse through it.
export {
  ceilDiv,
  convertAmountViaBtcRates,
  decimalScaleFactor,
  formatDecimal,
  isOpenReceiveBitcoinAmountCurrency,
  multiplyAmount,
  OPENRECEIVE_SATS_PER_BTC,
  OpenReceiveDecimalError,
  OpenReceivePriceFeedError,
  parseDecimal,
  sumAmounts,
} from "./money/decimal.ts";
export type {
  ListTransactionsRequest,
  ListTransactionsResult,
  MakeInvoiceRequest,
  MakeInvoiceResult,
  NwcEncryptionMode,
  NwcTransaction,
  NwcUriParseErrorCode,
  OpenReceiveReceiveNwcClient,
  OpenReceiveTransactionState,
  ParsedNwcConnection,
  RedactedNwcConnection,
  WalletCapabilitySummary,
} from "./nwc/client.ts";
export {
  formatOpenReceiveInvalidNwcMessage,
  formatOpenReceiveMissingNwcMessage,
  formatOpenReceiveSpendCapabilityRefusedMessage,
  formatOpenReceiveSpendCapabilityWarningMessage,
  isTransactionSettled,
  NwcUriParseError,
  OPENRECEIVE_NWC_CODE_HELP_URL,
  OPENRECEIVE_NWC_METADATA_MAX_BYTES,
  parseNwcUri,
  redactNwcUri,
} from "./nwc/client.ts";
export type {
  CheckPaymentOptions,
  PaidPayment,
  PaymentCheck,
  PaymentDetails,
  PaymentStatus,
  ReconcilePaymentAttempt,
  ReconcilePaymentsOptions,
} from "./payments.ts";
// Storage-free payment verification and reconciliation.
export { checkPayment, reconcilePaymentAttempts } from "./payments.ts";
// The one canonical statement of the order-table boundary and the host's
// exactly-once fulfillment duty, rendered into every generated file, migration
// template, and wiring guide so the guidance can never drift.
export {
  openReceiveFulfillmentNote,
  openReceiveFulfillmentNoteMarkdown,
} from "./fulfillment-note.ts";
export type {
  OpenReceivePaymentsDdlOptions,
  OpenReceivePaymentsDialect,
} from "./payments-ddl.ts";
// Canonical openreceive_payments / openreceive_meta DDL — the ONE rendering
// both @openreceive/http and the scaffold CLI build their migrations from.
export {
  OPENRECEIVE_PAYMENTS_SCHEMA_VERSION,
  openReceivePaymentsColumnNames,
  openReceivePaymentsDdlStatements,
  openReceivePaymentsHashCheckSql,
  openReceivePaymentsIndexName,
  openReceivePaymentsSeedSql,
  openReceivePaymentsStatusCheckSql,
} from "./payments-ddl.ts";
export type {
  CachedPriceFeedOptions,
  OpenReceiveBtcFiatRateMapWithSource,
  OpenReceiveDirectAmountQuote,
  OpenReceiveLivePriceSourceId,
  OpenReceivePriceFeedHealthCheck,
  OpenReceivePriceSourceId,
  OpenReceiveRateQuote,
  OpenReceiveResolvedPriceProvider,
  OpenReceiveSourcedPriceProvider,
  QuoteFiatToMsatsRequest,
  QuoteFiatToMsatsWithPriceRequest,
  SimplePriceFetch,
} from "./rates/index.ts";
// Rates — public quoting / provider surface (HTTP Simple Price helpers stay module-local)
export {
  CachedPriceFeed,
  createCachedLivePriceFeed,
  getBtcFiatRatesWithFallback,
  isResolvedPriceProvider,
  OPENRECEIVE_FALLBACK_PRICE_FEED_URL,
  OPENRECEIVE_INVOICE_QUOTE_TTL_SECONDS,
  OPENRECEIVE_MAX_AMOUNT_MSATS,
  OPENRECEIVE_MIN_AMOUNT_MSATS,
  OPENRECEIVE_PRICE_FEED_CACHE_SECONDS,
  OPENRECEIVE_PRICE_FEED_FALLBACK_TIMEOUT_MS,
  OPENRECEIVE_PRICE_FEED_FALLBACK_URL_ENV,
  OPENRECEIVE_PRICE_FEED_PRIMARY_TIMEOUT_MS,
  OPENRECEIVE_PRICE_FEED_PRIMARY_URL_ENV,
  OPENRECEIVE_PRICE_FEED_VS_CURRENCIES,
  OPENRECEIVE_PRIMARY_PRICE_FEED_URL,
  OPENRECEIVE_STATIC_BTC_FIAT_RATES,
  quoteBitcoinAmountToMsats,
  quoteFiatToMsatsWithPrice,
  StaticPriceProvider,
} from "./rates/index.ts";
export type {
  SettlementFinalitySignal,
  TransactionSettlementDetection,
  TransactionSettlementStatus,
} from "./settlement/index.ts";
// Settlement classification
export { classifyTransactionSettlement } from "./settlement/index.ts";
export type { OpenReceiveSwapAddressNetwork } from "./swap/address.ts";
// Swap address validation (deposit + refund), checksum-aware per network
export {
  getSwapRefundAddressError,
  isValidAddressForSwapNetwork,
  isValidSwapAddressForPayInAsset,
  openReceiveSwapAddressNetworkForPayInAsset,
} from "./swap/address.ts";
