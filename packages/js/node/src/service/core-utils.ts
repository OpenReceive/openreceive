import { isRecord, type ErrorBody, type ErrorCode } from "@openreceive/core";

export class ServiceError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly body: ErrorBody;

  constructor(status: number, body: ErrorBody) {
    super(body.message);
    this.name = "ServiceError";
    this.status = status;
    this.code = body.code;
    this.body = body;
  }
}

/** Core's `isRecord`, plus the 400 this service owes a caller that sends a non-object. */
export function asRecord(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw serviceError(400, "INVALID_REQUEST", "Input must be an object.");
  }
  return value;
}

export function parseOptionalRecord(
  value: unknown,
  field: string,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw serviceError(400, "INVALID_REQUEST", `${field} must be a JSON object.`);
  }
  return value;
}

export function serviceError(
  status: number,
  code: ErrorCode,
  message: string,
  options: { readonly retryable?: boolean } = {},
): ServiceError {
  return new ServiceError(status, {
    code,
    message,
    ...(options.retryable === undefined ? {} : { retryable: options.retryable }),
  });
}
