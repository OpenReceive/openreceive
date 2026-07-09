import {
  asRecord,
  isRecord,
  optionalString,
  parseOptionalRecord,
  serviceError,
} from "./core-utils.ts";
import type {
  NormalizedCreateCheckoutRequest,
  CreateCheckoutAmount,
  CreateCheckoutRequest,
  GetCheckoutRequest,
  GetOrderRequest,
} from "./types.ts";
import { HEX_64 } from "../hex.ts";
import { isOpenReceiveBitcoinAmountCurrency } from "@openreceive/core";

export function createAmountRequest(
  amount: CreateCheckoutAmount,
): Record<string, unknown> {
  const kind = readCreateAmountKind(amount);
  if (kind === "sats") {
    return {
      amount: {
        currency: "SATS",
        value: normalizeSatsValue(amount.sats),
      },
    };
  }
  const currency = amount.currency;
  const value = amount.value;
  if (currency === undefined || value === undefined) {
    throw serviceError(
      400,
      "INVALID_REQUEST",
      "Create checkout amount must be { sats } or { currency, value }.",
    );
  }
  if (isOpenReceiveBitcoinAmountCurrency(currency)) {
    return {
      amount: {
        currency,
        value,
      },
    };
  }
  return {
    fiat: {
      currency,
      value,
    },
  };
}

export function amountKeyFromCreateAmount(amount: CreateCheckoutAmount): string {
  const kind = readCreateAmountKind(amount);
  if (kind === "sats") {
    return `btc:SATS:${normalizeSatsValue(amount.sats)}`;
  }
  const currency = amount.currency;
  const value = amount.value;
  if (currency === undefined || value === undefined) {
    throw serviceError(
      400,
      "INVALID_REQUEST",
      "Create checkout amount must be { sats } or { currency, value }.",
    );
  }
  if (isOpenReceiveBitcoinAmountCurrency(currency)) {
    return `btc:${currency}:${value}`;
  }
  return `fiat:${currency}:${value}`;
}

export function readCreateAmountKind(amount: CreateCheckoutAmount): "sats" | "currency" {
  if (!isRecord(amount)) {
    throw serviceError(
      400,
      "INVALID_REQUEST",
      "Create checkout amount must be { sats } or { currency, value }.",
    );
  }

  const hasSats = "sats" in amount && amount.sats !== undefined;
  const hasCurrency = "currency" in amount && amount.currency !== undefined;
  const hasValue = "value" in amount && amount.value !== undefined;
  const unsupportedKeys = Object.keys(amount).filter(
    (key) => key !== "sats" && key !== "currency" && key !== "value",
  );

  if (unsupportedKeys.length > 0) {
    throw serviceError(
      400,
      "INVALID_REQUEST",
      "Create checkout amount must be { sats } or { currency, value }.",
    );
  }

  if (hasSats && !hasCurrency && !hasValue) {
    return "sats";
  }

  if (!hasSats && hasCurrency && hasValue) {
    return "currency";
  }

  throw serviceError(
    400,
    "INVALID_REQUEST",
    "Create checkout amount must be { sats } or { currency, value }.",
  );
}

export function getCreateDescriptionFields(input: {
  readonly memo?: unknown;
  readonly descriptionHash?: unknown;
}): {
  readonly description?: string;
  readonly description_hash?: string;
} {
  const memo = optionalString(input.memo);
  const descriptionHash = optionalString(input.descriptionHash);

  if (memo !== undefined && memo.length > 500) {
    throw serviceError(400, "INVALID_REQUEST", "memo must be 500 characters or fewer.");
  }

  if (memo !== undefined && descriptionHash !== undefined) {
    throw serviceError(
      400,
      "INVALID_REQUEST",
      "Create checkout request accepts only one of memo or descriptionHash.",
    );
  }

  if (descriptionHash !== undefined && !HEX_64.test(descriptionHash)) {
    throw serviceError(400, "INVALID_REQUEST", "descriptionHash must be 64 hex characters.");
  }

  return {
    ...(memo === undefined ? {} : { description: memo }),
    ...(descriptionHash === undefined ? {} : { description_hash: descriptionHash }),
  };
}

export function normalizeCreateCheckoutRequest(
  input: CreateCheckoutRequest,
): NormalizedCreateCheckoutRequest {
  const body = asRecord(input);
  const orderId = parseOrderId(body);
  const amount = normalizeCreateCheckoutAmount(body);
  const memo = optionalString(body.memo);
  const descriptionHash = optionalString(body.descriptionHash ?? body.description_hash);
  const metadata = parseOptionalRecord(body.metadata, "metadata");

  return {
    order_id: orderId,
    amount,
    ...(memo === undefined ? {} : { memo }),
    ...(descriptionHash === undefined ? {} : { description_hash: descriptionHash }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

export function normalizeCreateCheckoutAmount(
  body: Record<string, unknown>,
): CreateCheckoutAmount {
  if (body.usd !== undefined || body.sats !== undefined) {
    throw serviceError(
      400,
      "INVALID_REQUEST",
      "Create checkout request no longer accepts top-level usd or sats; use amount: { currency, value } or amount: { sats }.",
    );
  }

  if (body.amount === undefined) {
    throw serviceError(
      400,
      "INVALID_REQUEST",
      "Create checkout request requires amount: { sats } or amount: { currency, value }.",
    );
  }

  const amount = body.amount as CreateCheckoutAmount;
  readCreateAmountKind(amount);
  if ("sats" in amount && amount.sats !== undefined) {
    return { sats: normalizeSatsValue(amount.sats) };
  }
  const currency = optionalString((amount as { currency?: unknown }).currency);
  const value = optionalString((amount as { value?: unknown }).value);
  if (currency === undefined || value === undefined) {
    throw serviceError(
      400,
      "INVALID_REQUEST",
      "Create checkout amount must be { sats } or { currency, value }.",
    );
  }
  if (isOpenReceiveBitcoinAmountCurrency(currency)) {
    return { currency, value };
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw serviceError(
      400,
      "INVALID_REQUEST",
      "amount.currency must be an ISO 4217 uppercase code, or BTC/SAT/SATS.",
    );
  }
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(value) || /^0+(?:\.0+)?$/.test(value)) {
    throw serviceError(400, "INVALID_REQUEST", "amount.value must be a positive decimal string.");
  }
  return { currency, value };
}

export function normalizeSatsValue(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw serviceError(400, "INVALID_REQUEST", "sats must be a positive integer.");
    }
    return String(value);
  }

  if (typeof value === "string" && /^[0-9]+$/.test(value) && BigInt(value) > 0n) {
    return value;
  }

  throw serviceError(400, "INVALID_REQUEST", "sats must be a positive integer.");
}

export function parseOrderId(body: Record<string, unknown>): string {
  const orderId = optionalString(body.orderId ?? body.order_id);
  if (orderId === undefined) {
    throw serviceError(400, "INVALID_REQUEST", "orderId is required.");
  }
  if (orderId.length > 200) {
    throw serviceError(400, "INVALID_REQUEST", "orderId must be 200 characters or fewer.");
  }
  return orderId;
}

export function parseGetCheckoutId(input: GetCheckoutRequest): string {
  const body = asRecord(input);
  const checkoutId = optionalString(body.checkoutId ?? body.checkout_id);
  if (checkoutId === undefined) {
    throw serviceError(400, "INVALID_REQUEST", "checkoutId is required.");
  }
  if (checkoutId.length > 200) {
    throw serviceError(400, "INVALID_REQUEST", "checkoutId must be 200 characters or fewer.");
  }
  return checkoutId;
}

export function parseGetOrderId(input: GetOrderRequest): string {
  return parseOrderId(asRecord(input));
}
