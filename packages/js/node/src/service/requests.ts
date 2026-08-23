import { isBitcoinAmountCurrency, isRecord, nonEmptyString } from "@openreceive/core";
import { HEX_64 } from "../hex.ts";
import { asRecord, parseOptionalRecord, serviceError } from "./core-utils.ts";
import type {
  CreateCheckoutAmount,
  CreateCheckoutRequest,
  NormalizedCreateCheckoutRequest,
} from "./types.ts";

export function createAmountRequest(amount: CreateCheckoutAmount): Record<string, unknown> {
  if ("sats" in amount) {
    return { amount: { currency: "SATS", value: normalizeSatsValue(amount.sats) } };
  }
  if (isBitcoinAmountCurrency(amount.currency)) {
    return { amount: { currency: amount.currency, value: amount.value } };
  }
  return { fiat: { currency: amount.currency, value: amount.value } };
}

/** The declared {@link CreateCheckoutRequest} fields — the only accepted keys. */
const CREATE_CHECKOUT_REQUEST_FIELDS: readonly string[] = [
  "reference",
  "amount",
  "memo",
  "descriptionHash",
  "metadata",
  "expirySeconds",
];

export function normalizeCreateCheckoutRequest(
  input: CreateCheckoutRequest,
): NormalizedCreateCheckoutRequest {
  const body = asRecord(input);
  // The service accepts exactly the declared camelCase fields, mirroring how
  // the HTTP layer accepts exactly the declared snake_case wire fields —
  // aliases in either casing are rejected, not ignored.
  for (const key of Object.keys(body)) {
    if (!CREATE_CHECKOUT_REQUEST_FIELDS.includes(key)) {
      throw serviceError(400, "INVALID_REQUEST", `Unexpected create checkout field: ${key}.`);
    }
  }
  const reference = nonEmptyString(body.reference);
  if (reference === undefined) throw serviceError(400, "INVALID_REQUEST", "reference is required.");
  if (reference.length > 200) {
    throw serviceError(400, "INVALID_REQUEST", "reference must be 200 characters or fewer.");
  }
  const amount = normalizeCreateCheckoutAmount(body.amount);
  const memo = nonEmptyString(body.memo);
  const descriptionHash = nonEmptyString(body.descriptionHash);
  getCreateDescriptionFields({ memo, descriptionHash });
  const metadata = parseOptionalRecord(body.metadata, "metadata");
  const expirySeconds = body.expirySeconds;
  if (
    expirySeconds !== undefined &&
    (!Number.isSafeInteger(expirySeconds) || (expirySeconds as number) <= 0)
  ) {
    throw serviceError(400, "INVALID_REQUEST", "expirySeconds must be a positive safe integer.");
  }
  return {
    reference,
    amount,
    ...(memo === undefined ? {} : { memo }),
    ...(descriptionHash === undefined ? {} : { descriptionHash }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(expirySeconds === undefined ? {} : { expirySeconds: expirySeconds as number }),
  };
}

export function normalizeCreateCheckoutAmount(value: unknown): CreateCheckoutAmount {
  if (!isRecord(value)) {
    throw serviceError(400, "INVALID_REQUEST", "amount must be { sats } or { currency, value }.");
  }
  const keys = Object.keys(value);
  if ("sats" in value && value.sats !== undefined && keys.every((key) => key === "sats")) {
    return { sats: normalizeSatsValue(value.sats) };
  }
  if (keys.some((key) => key !== "currency" && key !== "value")) {
    throw serviceError(400, "INVALID_REQUEST", "amount contains unsupported fields.");
  }
  const currency = nonEmptyString(value.currency);
  const amountValue = nonEmptyString(value.value);
  if (currency === undefined || amountValue === undefined) {
    throw serviceError(400, "INVALID_REQUEST", "amount must be { sats } or { currency, value }.");
  }
  if (!isBitcoinAmountCurrency(currency) && !/^[A-Z]{3}$/.test(currency)) {
    throw serviceError(
      400,
      "INVALID_REQUEST",
      "amount.currency must be uppercase ISO 4217, BTC, SAT, or SATS.",
    );
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
  const memo = nonEmptyString(input.memo);
  const descriptionHash = nonEmptyString(input.descriptionHash);
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
