import {
  type GeneratedErrorCode,
  OPENRECEIVE_ERROR_CODES,
  OPENRECEIVE_RETRYABLE_ERROR_CODES,
} from "../generated/contracts.ts";

export type ErrorCode = GeneratedErrorCode;

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  retryable?: boolean;
  request_id?: string;
  details?: Record<string, unknown>;
}

export class OpenReceiveError extends Error implements ErrorBody {
  readonly code: ErrorCode;
  readonly retryable?: boolean;
  readonly request_id?: string;
  readonly details?: Record<string, unknown>;

  constructor(input: ErrorBody, options?: ErrorOptions) {
    super(input.message, options);
    this.name = "OpenReceiveError";
    this.code = input.code;
    if (input.retryable !== undefined) this.retryable = input.retryable;
    if (input.request_id !== undefined) this.request_id = input.request_id;
    if (input.details !== undefined) this.details = input.details;
  }

  toJSON(): ErrorBody {
    return {
      code: this.code,
      message: this.message,
      ...(this.retryable === undefined ? {} : { retryable: this.retryable }),
      ...(this.request_id === undefined ? {} : { request_id: this.request_id }),
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

const OPENRECEIVE_ERROR_CODE_SET = new Set<string>(OPENRECEIVE_ERROR_CODES);
const OPENRECEIVE_RETRYABLE_ERROR_CODE_SET = new Set<string>(
  OPENRECEIVE_RETRYABLE_ERROR_CODES satisfies readonly ErrorCode[],
);

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && OPENRECEIVE_ERROR_CODE_SET.has(value);
}

export function isRetryableErrorCode(code: ErrorCode): boolean {
  return OPENRECEIVE_RETRYABLE_ERROR_CODE_SET.has(code);
}
