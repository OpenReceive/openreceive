export type OpenReceiveConfigErrorCode =
  | "MISSING_NWC"
  | "INVALID_NWC"
  | "WALLET_PREFLIGHT_FAILED"
  | "INVALID_PRICE_CURRENCIES";

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
