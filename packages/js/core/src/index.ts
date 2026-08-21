// NWC client
export {
  OPENRECEIVE_NWC_METADATA_MAX_BYTES,
  OPENRECEIVE_NWC_CODE_HELP_URL,
  NwcUriParseError,
  formatOpenReceiveMissingNwcMessage,
  formatOpenReceiveInvalidNwcMessage,
  formatOpenReceiveSpendCapabilityRefusedMessage,
  formatOpenReceiveSpendCapabilityWarningMessage,
  isTransactionSettled,
  parseNwcUri,
  redactNwcUri,
} from "./nwc/client.ts";
export type {
  NwcEncryptionMode,
  NwcUriParseErrorCode,
  OpenReceiveTransactionState,
  ParsedNwcConnection,
  RedactedNwcConnection,
  WalletCapabilitySummary,
  MakeInvoiceRequest,
  MakeInvoiceResult,
  ListTransactionsRequest,
  NwcTransaction,
  ListTransactionsResult,
  OpenReceiveReceiveNwcClient,
} from "./nwc/client.ts";

// Errors
export {
  OpenReceiveError,
  isOpenReceiveErrorCode,
  isRetryableOpenReceiveErrorCode,
} from "./errors/index.ts";
export type { OpenReceiveErrorCode, OpenReceiveErrorBody } from "./errors/index.ts";

// Exact integer/decimal money math (bigint — never binary floats). The one
// decimal engine: rate quoting and the Node swap providers parse through it.
export {
  OPENRECEIVE_SATS_PER_BTC,
  OpenReceiveDecimalError,
  OpenReceivePriceFeedError,
  parseDecimal,
  formatDecimal,
  decimalScaleFactor,
  ceilDiv,
  formatBtcFromSats,
  isOpenReceiveBitcoinAmountCurrency,
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
  OpenReceiveFiatAmount,
  OpenReceiveBitcoinAmount,
  OpenReceiveBtcFiatRateMap,
} from "./money/decimal.ts";

// Rates — public quoting / provider surface (HTTP Simple Price helpers stay module-local)
export {
  OPENRECEIVE_PRICE_FEED_CACHE_SECONDS,
  OPENRECEIVE_INVOICE_QUOTE_TTL_SECONDS,
  OPENRECEIVE_PRICE_FEED_PRIMARY_TIMEOUT_MS,
  OPENRECEIVE_PRICE_FEED_FALLBACK_TIMEOUT_MS,
  OPENRECEIVE_STATIC_BTC_FIAT_RATES,
  OPENRECEIVE_PRICE_FEED_VS_CURRENCIES,
  OPENRECEIVE_PRIMARY_PRICE_FEED_URL,
  OPENRECEIVE_FALLBACK_PRICE_FEED_URL,
  OPENRECEIVE_PRICE_FEED_PRIMARY_URL_ENV,
  OPENRECEIVE_PRICE_FEED_FALLBACK_URL_ENV,
  OPENRECEIVE_MIN_AMOUNT_MSATS,
  OPENRECEIVE_MAX_AMOUNT_MSATS,
  quoteBitcoinAmountToMsats,
  getStaticBtcFiatPrice,
  quoteFiatToMsatsWithPrice,
  quoteFiatToMsatsAtMockRate,
  StaticPriceProvider,
  createCachedLivePriceFeed,
  CachedPriceFeed,
  isResolvedPriceProvider,
  getBtcFiatRatesWithFallback,
} from "./rates/index.ts";
export type {
  OpenReceivePriceSourceId,
  OpenReceiveLivePriceSourceId,
  OpenReceiveDirectAmountQuote,
  OpenReceiveRateQuote,
  QuoteFiatToMsatsRequest,
  QuoteFiatToMsatsWithPriceRequest,
  OpenReceiveSourcedPriceProvider,
  OpenReceiveBtcFiatRateMapWithSource,
  SimplePriceFetch,
  OpenReceiveResolvedPriceProvider,
  OpenReceivePriceFeedHealthCheck,
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

// Storage-free payment verification and reconciliation.
export {
  OPENRECEIVE_TRANSACTION_PAGE_LIMIT,
  checkPayment,
  reconcilePaymentAttempts,
} from "./payments.ts";
export type {
  CheckPaymentOptions,
  PaidPayment,
  PaymentCheck,
  PaymentDetails,
  PaymentStatus,
  ReconcilePaymentAttempt,
  ReconcilePaymentsOptions,
} from "./payments.ts";

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
  OpenReceivePaymentsDdlOptions,
  OpenReceivePaymentsDialect,
} from "./payments-ddl.ts";

// Swap address validation (deposit + refund), checksum-aware per network
export {
  isValidAddressForSwapNetwork,
  openReceiveSwapAddressNetworkForPayInAsset,
  isValidSwapAddressForPayInAsset,
  getSwapRefundAddressError,
} from "./swap/address.ts";
export type { OpenReceiveSwapAddressNetwork } from "./swap/address.ts";
