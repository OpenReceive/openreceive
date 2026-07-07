import type { OpenReceiveErrorBody, OpenReceiveErrorCode } from "@openreceive/core";
import { OpenReceiveConfigError } from "../config-error.ts";

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

export function optionalSafeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) ? (value as number) : undefined;
}

export function readOpenReceiveNamespace(configured: string | undefined): string {
  const namespace = configured ?? "default";
  if (namespace.trim().length === 0) {
    throw new OpenReceiveConfigError({
      code: "STORE_UNAVAILABLE",
      message: "OPENRECEIVE_NAMESPACE must not be empty.",
      hint: "Set OPENRECEIVE_NAMESPACE in openreceive.yml to a stable non-empty app namespace, or omit it to use default.",
    });
  }
  return namespace;
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

export function requiredValue<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("required value was missing");
  }
  return value;
}

export function toSafeInteger(value: bigint | number, field: string): number {
  const numberValue = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(numberValue)) {
    throw serviceError(500, "INTERNAL", `${field} is outside JavaScript safe integer bounds.`);
  }
  return numberValue;
}

export function createStoredInvoiceId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `or_inv_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function createCheckoutId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `or_chk_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
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
