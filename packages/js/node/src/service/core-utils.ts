import type { OpenReceiveErrorBody, OpenReceiveErrorCode } from "@openreceive/core";

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

export function asRecord(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw serviceError(400, "INVALID_REQUEST", "Input must be an object.");
  }
  return value as Record<string, unknown>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parseOptionalRecord(
  value: unknown,
  field: string,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw serviceError(400, "INVALID_REQUEST", `${field} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

export function toSafeInteger(value: bigint | number, field: string): number {
  const numberValue = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(numberValue)) {
    throw serviceError(500, "INTERNAL", `${field} is outside JavaScript safe integer bounds.`);
  }
  return numberValue;
}

export function currentUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function serviceError(
  status: number,
  code: OpenReceiveErrorCode,
  message: string,
): OpenReceiveServiceError {
  return new OpenReceiveServiceError(status, {
    code,
    message,
  });
}
