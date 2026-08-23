export type ConfigErrorCode =
  | "MISSING_NWC"
  | "INVALID_NWC"
  | "WALLET_PREFLIGHT_FAILED"
  | "INVALID_PRICE_CURRENCIES";

export class ConfigError extends Error {
  readonly code: ConfigErrorCode;
  readonly hint: string;
  override readonly cause?: unknown;

  constructor(input: {
    readonly code: ConfigErrorCode;
    readonly message: string;
    readonly hint: string;
    readonly cause?: unknown;
  }) {
    super(input.message);
    this.name = "ConfigError";
    this.code = input.code;
    this.hint = input.hint;
    this.cause = input.cause;
  }
}
