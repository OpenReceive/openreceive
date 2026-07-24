import { isOpenReceiveBitcoinAmountCurrency } from "@openreceive/core";
import { HEX_64 } from "../hex.ts";
import { asRecord, isRecord, optionalString, parseOptionalRecord, serviceError } from "./core-utils.ts";
import type {
  CreateCheckoutAmount,
  CreateCheckoutRequest,
  NormalizedCreateCheckoutRequest,
} from "./types.ts";

export function createAmountRequest(amount: CreateCheckoutAmount): Record<string, unknown> {
  if ("sats" in amount) {
    return { amount: { currency: "SATS", value: normalizeSatsValue(amount.sats) } };
  }
  if (isOpenReceiveBitcoinAmountCurrency(amount.currency)) {
    return { amount: { currency: amount.currency, value: amount.value } };
  }
  return { fiat: { currency: amount.currency, value: amount.value } };
}

export function normalizeCreateCheckoutRequest(
  input: CreateCheckoutRequest,
): NormalizedCreateCheckoutRequest {
  const body = asRecord(input);
  const orderId = optionalString(body.orderId ?? body.order_id);
  if (orderId === undefined) throw serviceError(400, "INVALID_REQUEST", "orderId is required.");
  if (orderId.length > 200) {
    throw serviceError(400, "INVALID_REQUEST", "orderId must be 200 characters or fewer.");
  }
  const amount = normalizeCreateCheckoutAmount(body.amount);
  const memo = optionalString(body.memo);
  const descriptionHash = optionalString(body.descriptionHash ?? body.description_hash);
  getCreateDescriptionFields({ memo, descriptionHash });
  const metadata = parseOptionalRecord(body.metadata, "metadata");
  const expirySeconds = body.expirySeconds ?? body.expiry_seconds;
  if (
    expirySeconds !== undefined &&
    (!Number.isSafeInteger(expirySeconds) || (expirySeconds as number) <= 0)
  ) {
    throw serviceError(400, "INVALID_REQUEST", "expirySeconds must be a positive safe integer.");
  }
  return {
    order_id: orderId,
    amount,
    ...(memo === undefined ? {} : { memo }),
    ...(descriptionHash === undefined ? {} : { description_hash: descriptionHash }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(expirySeconds === undefined ? {} : { expiry_seconds: expirySeconds as number }),
  };
}

export function normalizeCreateCheckoutAmount(value: unknown): CreateCheckoutAmount {
  if (!isRecord(value)) {
    throw serviceError(
      400,
      "INVALID_REQUEST",
      "amount must be { sats } or { currency, value }.",
    );
  }
  const keys = Object.keys(value);
  if ("sats" in value && value.sats !== undefined && keys.every((key) => key === "sats")) {
    return { sats: normalizeSatsValue(value.sats) };
  }
  if (keys.some((key) => key !== "currency" && key !== "value")) {
    throw serviceError(400, "INVALID_REQUEST", "amount contains unsupported fields.");
  }
  const currency = optionalString(value.currency);
  const amountValue = optionalString(value.value);
  if (currency === undefined || amountValue === undefined) {
    throw serviceError(400, "INVALID_REQUEST", "amount must be { sats } or { currency, value }.");
  }
  if (!isOpenReceiveBitcoinAmountCurrency(currency) && !/^[A-Z]{3}$/.test(currency)) {
    throw serviceError(400, "INVALID_REQUEST", "amount.currency must be uppercase ISO 4217, BTC, SAT, or SATS.");
  }
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(amountValue) || /^0+(?:\.0+)?$/.test(amountValue)) {
    throw serviceError(400, "INVALID_REQUEST", "amount.value must be a positive decimal string.");
  }
  return { currency, value: amountValue };
}

export function normalizeSatsValue(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[0-9]+$/.test(value) && BigInt(value) > 0n) return value;
  throw serviceError(400, "INVALID_REQUEST", "sats must be a positive integer.");
}

export function getCreateDescriptionFields(input: {
  readonly memo?: unknown;
  readonly descriptionHash?: unknown;
}): { readonly description?: string; readonly description_hash?: string } {
  const memo = optionalString(input.memo);
  const descriptionHash = optionalString(input.descriptionHash);
  if (memo !== undefined && memo.length > 500) {
    throw serviceError(400, "INVALID_REQUEST", "memo must be 500 characters or fewer.");
  }
  if (memo !== undefined && descriptionHash !== undefined) {
    throw serviceError(400, "INVALID_REQUEST", "Use only one of memo or descriptionHash.");
  }
  if (descriptionHash !== undefined && !HEX_64.test(descriptionHash)) {
    throw serviceError(400, "INVALID_REQUEST", "descriptionHash must be 64 hex characters.");
  }
  return {
    ...(memo === undefined ? {} : { description: memo }),
    ...(descriptionHash === undefined ? {} : { description_hash: descriptionHash }),
  };
}
