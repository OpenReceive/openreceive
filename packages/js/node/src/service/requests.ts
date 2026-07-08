import {
  asRecord,
  isRecord,
  optionalString,
  parseOptionalRecord,
  serviceError,
} from "./core-utils.ts";
import type {
  NormalizedCreateCheckoutRequest,
  OpenReceiveCreateCheckoutAmount,
  OpenReceiveCreateCheckoutRequest,
  OpenReceiveGetCheckoutRequest,
  OpenReceiveGetOrderRequest,
} from "./types.ts";
import { HEX_64 } from "../hex.ts";

export function createAmountRequest(
  amount: OpenReceiveCreateCheckoutAmount,
): Record<string, unknown> {
  readCreateAmountKind(amount);
  return {
    ...("btc" in amount ? { amount: amount.btc } : {}),
    ...("fiat" in amount ? { fiat: amount.fiat } : {}),
  };
}

export function amountKeyFromCreateAmount(amount: OpenReceiveCreateCheckoutAmount): string {
  readCreateAmountKind(amount);
  if ("fiat" in amount) {
    return `fiat:${amount.fiat.currency}:${amount.fiat.value}`;
  }
  return `btc:${amount.btc.currency}:${amount.btc.value}`;
}

export function readCreateAmountKind(amount: OpenReceiveCreateCheckoutAmount): "btc" | "fiat" {
  if (!isRecord(amount)) {
    throw serviceError(
      400,
      "INVALID_REQUEST",
      "Create checkout request requires exactly one of amount.btc or amount.fiat.",
    );
  }

  const unsupportedKeys = Object.keys(amount).filter((key) => key !== "btc" && key !== "fiat");
  const hasBtc = "btc" in amount && amount.btc !== undefined;
  const hasFiat = "fiat" in amount && amount.fiat !== undefined;
  if (unsupportedKeys.length > 0 || [hasBtc, hasFiat].filter(Boolean).length !== 1) {
    throw serviceError(
      400,
      "INVALID_REQUEST",
      "Create checkout request requires exactly one of amount.btc or amount.fiat.",
    );
  }
  return hasBtc ? "btc" : "fiat";
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
  input: OpenReceiveCreateCheckoutRequest,
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
): OpenReceiveCreateCheckoutAmount {
  const sourceCount = [
    body.amount !== undefined,
    body.usd !== undefined,
    body.sats !== undefined,
  ].filter(Boolean).length;

  if (sourceCount !== 1) {
    throw serviceError(
      400,
      "INVALID_REQUEST",
      "Create checkout request requires exactly one of amount, usd, or sats.",
    );
  }

  if (body.amount !== undefined) {
    readCreateAmountKind(body.amount as OpenReceiveCreateCheckoutAmount);
    return structuredClone(body.amount) as OpenReceiveCreateCheckoutAmount;
  }

  if (body.usd !== undefined) {
    const value = optionalString(body.usd);
    if (
      value === undefined ||
      !/^[0-9]+(?:\.[0-9]+)?$/.test(value) ||
      /^0+(?:\.0+)?$/.test(value)
    ) {
      throw serviceError(400, "INVALID_REQUEST", "usd must be a positive decimal string.");
    }
    return {
      fiat: {
        currency: "USD",
        value,
      },
    };
  }

  return {
    btc: {
      currency: "SATS",
      value: normalizeSatsShortcut(body.sats),
    },
  };
}

export function normalizeSatsShortcut(value: unknown): string {
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

export function parseGetCheckoutId(input: OpenReceiveGetCheckoutRequest): string {
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

export function parseGetOrderId(input: OpenReceiveGetOrderRequest): string {
  return parseOrderId(asRecord(input));
}
