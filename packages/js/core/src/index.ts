// NWC client

export type { ErrorBody, ErrorCode } from "./errors/index.ts";
// Errors
export {
  isErrorCode,
  isRetryableErrorCode,
  OpenReceiveError,
} from "./errors/index.ts";
export type {
  BitcoinAmount,
  BtcFiatRateMap,
  Decimal,
  MoneyAmount,
} from "./money/decimal.ts";
// Exact integer/decimal money math (bigint — never binary floats). The one
// decimal engine: rate quoting and the Node swap providers parse through it.
export {
  ceilDiv,
  convertAmountViaBtcRates,
  decimalScaleFactor,
  formatDecimal,
  isBitcoinAmountCurrency,
  multiplyAmount,
  OPENRECEIVE_SATS_PER_BTC,
  DecimalError,
  PriceFeedError,
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
  ReceiveNwcClient,
  TransactionState,
  ParsedNwcConnection,
  RedactedNwcConnection,
  WalletCapabilitySummary,
} from "./nwc/client.ts";
export {
  formatInvalidNwcMessage,
  formatMissingNwcMessage,
  formatSpendCapabilityRefusedMessage,
  formatSpendCapabilityWarningMessage,
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
  fulfillmentNote,
  fulfillmentNoteMarkdown,
} from "./fulfillment-note.ts";
export type {
  PaymentsDdlOptions,
  PaymentsDialect,
} from "./payments-ddl.ts";
// Canonical openreceive_payments / openreceive_meta DDL — the ONE rendering
// both @openreceive/http and the scaffold CLI build their migrations from.
export {
  OPENRECEIVE_PAYMENTS_SCHEMA_VERSION,
  paymentsColumnNames,
  paymentsDdlStatements,
  paymentsHashCheckSql,
  paymentsIndexName,
  paymentsSeedSql,
  paymentsStatusCheckSql,
} from "./payments-ddl.ts";
export type {
  CachedPriceFeedOptions,
  BtcFiatRateMapWithSource,
  DirectAmountQuote,
  LivePriceSourceId,
  PriceFeedHealthCheck,
  PriceSourceId,
  RateQuote,
  ResolvedPriceProvider,
  SourcedPriceProvider,
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
  OPENRECEIVE_MAX_AMOUNT_MSATS,
  OPENRECEIVE_MIN_AMOUNT_MSATS,
  OPENRECEIVE_PRICE_FEED_FALLBACK_URL_ENV,
  OPENRECEIVE_PRICE_FEED_PRIMARY_URL_ENV,
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
export type { SwapAddressNetwork } from "./swap/address.ts";
// Swap address validation (deposit + refund), checksum-aware per network
export {
  getSwapRefundAddressError,
  isValidAddressForSwapNetwork,
  isValidSwapAddressForPayInAsset,
  swapAddressNetworkForPayInAsset,
} from "./swap/address.ts";
// Shared value primitives — the one clock, the two record readers, the
// non-empty-string reader, and the undefined-field compactor. Public because
// every package needs them and a published-internal subpath would cost more
// than these five names do.
export {
  compact,
  isRecord,
  nonEmptyString,
  recordOrEmpty,
  unixSeconds,
} from "./values.ts";
