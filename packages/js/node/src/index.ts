export { OpenReceiveError } from "@openreceive/core";
export type {
  OpenReceiveErrorBody,
  OpenReceiveErrorCode,
  OpenReceiveReceiveNwcClient,
  PaidPayment,
  PaymentCheck,
} from "@openreceive/core";
export {
  ReceiveCheckoutValidationError,
  WalletPreflightError,
  SPEND_CAPABILITY_WARNING_DELAY_MS,
  createNwcReceiveClient,
  normalizeNwcWalletError,
  summarizeWalletCapabilities,
} from "./alby-nwc.ts";
export type {
  AlbyNwcReceiveClientOptions,
  NwcEndpointLogEntry,
  NwcEndpointLogLevel,
  NwcEndpointLogger,
  NwcNotificationUnsubscribe,
  WalletPreflightErrorCode,
} from "./alby-nwc.ts";
export {
  LSC_ENV_NAMES,
  LSC_URI_PROTOCOL,
  createLscSwapProvidersFromEnvironment,
  formatLscUri,
  parseLscUri,
  readLscConnectionsFromEnvironment,
} from "./lsc-uri.ts";
export type {
  CreateLscSwapProvidersOptions,
  FormatLscUriInput,
  LscConnection,
  LscEnvironmentName,
} from "./lsc-uri.ts";
export {
  OpenReceiveConfigError,
  OpenReceiveServiceError,
  createOpenReceive,
  createOpenReceivePriceFeed,
} from "./service.ts";
// The redaction every service log sink applies, so code outside the service
// (the mounted HTTP layer's default warnings) can reuse it rather than
// printing raw wallet or provider error text.
export { sanitizeOpenReceiveEvent } from "./service/logging.ts";
export type * from "./service/types.ts";
export {
  fixedFloatCompatibleSwapProvider,
  fixedFloatProvider,
  isOpenReceiveSwapTerminalState,
  OPENRECEIVE_SWAP_PAY_IN_ASSETS,
  OPENRECEIVE_SWAP_STATES,
} from "./swap/index.ts";
export type {
  FixedFloatCompatibleSwapProviderOptions,
  FixedFloatProviderOptions,
  SwapAttentionReason,
  SwapOrder,
  SwapPayInAsset,
  SwapProvider,
  SwapProviderAsset,
  SwapProviderState,
  SwapQuote,
} from "./swap/index.ts";
export { readNwcFromEnvironment, requireNwcFromEnvironment } from "./require-nwc.ts";
export type { RequireNwcFromEnvironmentOptions } from "./require-nwc.ts";
export {
  createHostConsoleLogger,
  createOpenReceiveConsoleLogger,
  openReceiveLogLevelOrder,
  parseOpenReceiveLogLevel,
  readOpenReceiveLogLevelFromEnvironment,
  resolveOpenReceiveLogLevel,
} from "./console-logger.ts";
export type {
  CreateHostConsoleLoggerOptions,
  CreateOpenReceiveConsoleLoggerOptions,
  HostConsoleLogger,
} from "./console-logger.ts";
