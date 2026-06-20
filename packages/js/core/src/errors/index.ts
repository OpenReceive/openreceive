import {
  OPENRECEIVE_ERROR_CODES,
  type OpenReceiveGeneratedErrorCode
} from "../generated/contracts.ts";

export type OpenReceiveErrorCode = OpenReceiveGeneratedErrorCode;

export interface OpenReceiveErrorBody {
  code: OpenReceiveErrorCode;
  message: string;
  retryable?: boolean;
  request_id?: string;
  details?: Record<string, unknown>;
}

export class OpenReceiveError extends Error implements OpenReceiveErrorBody {
  readonly code: OpenReceiveErrorCode;
  readonly retryable?: boolean;
  readonly request_id?: string;
  readonly details?: Record<string, unknown>;

  constructor(input: OpenReceiveErrorBody, options?: ErrorOptions) {
    super(input.message, options);
    this.name = "OpenReceiveError";
    this.code = input.code;
    if (input.retryable !== undefined) this.retryable = input.retryable;
    if (input.request_id !== undefined) this.request_id = input.request_id;
    if (input.details !== undefined) this.details = input.details;
  }

  toJSON(): OpenReceiveErrorBody {
    return {
      code: this.code,
      message: this.message,
      ...(this.retryable === undefined ? {} : { retryable: this.retryable }),
      ...(this.request_id === undefined ? {} : { request_id: this.request_id }),
      ...(this.details === undefined ? {} : { details: this.details })
    };
  }
}

const OPENRECEIVE_ERROR_CODE_SET = new Set<string>(OPENRECEIVE_ERROR_CODES);
const OPENRECEIVE_RETRYABLE_ERROR_CODE_SET = new Set<string>([
  "RATE_LIMITED",
  "QUOTA_EXCEEDED",
  "TIMEOUT",
  "WALLET_UNAVAILABLE",
  "INTERNAL"
] satisfies readonly OpenReceiveErrorCode[]);

export function isOpenReceiveErrorCode(
  value: unknown
): value is OpenReceiveErrorCode {
  return typeof value === "string" && OPENRECEIVE_ERROR_CODE_SET.has(value);
}

export function isRetryableOpenReceiveErrorCode(
  code: OpenReceiveErrorCode
): boolean {
  return OPENRECEIVE_RETRYABLE_ERROR_CODE_SET.has(code);
}
