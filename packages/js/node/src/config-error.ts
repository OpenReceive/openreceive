export type OpenReceiveConfigErrorCode =
  | "MISSING_NWC"
  | "INVALID_NWC"
  | "WALLET_PREFLIGHT_FAILED"
  | "STORE_UNAVAILABLE"
  | "EPHEMERAL_STORE_UNSAFE"
  | "UNSUPPORTED_STORE_REDIS"
  | "UNSAFE_MEMORY_STORE"
  | "STORE_MUST_BE_EXPLICIT"
  | "STORE_NOT_IMPLEMENTED"
  | "UNSUPPORTED_STORE_URI"
  | "INVALID_PRICE_CURRENCIES"
  | "UNHEALTHY_PRICE_DATA";

export class OpenReceiveConfigError extends Error {
  readonly code: OpenReceiveConfigErrorCode;
  readonly hint: string;
  override readonly cause?: unknown;

  constructor(input: {
    readonly code: OpenReceiveConfigErrorCode;
    readonly message: string;
    readonly hint: string;
    readonly cause?: unknown;
  }) {
    super(input.message);
    this.name = "OpenReceiveConfigError";
    this.code = input.code;
    this.hint = input.hint;
    this.cause = input.cause;
  }
}
