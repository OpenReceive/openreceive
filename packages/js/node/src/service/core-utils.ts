import { isRecord, type OpenReceiveErrorBody, type OpenReceiveErrorCode } from "@openreceive/core";

export class OpenReceiveServiceError extends Error {
  readonly status: number;
  readonly code: OpenReceiveErrorCode;
  readonly body: OpenReceiveErrorBody;

  constructor(status: number, body: OpenReceiveErrorBody) {
    super(body.message);
    this.name = "OpenReceiveServiceError";
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
  code: OpenReceiveErrorCode,
  message: string,
  options: { readonly retryable?: boolean } = {},
): OpenReceiveServiceError {
  return new OpenReceiveServiceError(status, {
    code,
    message,
    ...(options.retryable === undefined ? {} : { retryable: options.retryable }),
  });
}
