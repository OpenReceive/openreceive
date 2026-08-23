/**
 * NIP-47 request building, request validation, and reply normalization.
 *
 * Everything here is a pure function over a value the wallet already returned,
 * so every accept/degrade/skip rule is testable without a relay. Reply handling
 * is deliberately tolerant per field: the wallet is trusted, and one quirky row
 * must never fail a reconciliation scan.
 */

import {
  type ListTransactionsRequest,
  type ListTransactionsResult,
  type MakeInvoiceRequest,
  type MakeInvoiceResult,
  type NwcEncryptionMode,
  type NwcTransaction,
  OPENRECEIVE_MAX_AMOUNT_MSATS,
  OPENRECEIVE_MIN_AMOUNT_MSATS,
  OPENRECEIVE_NWC_METADATA_MAX_BYTES,
  type TransactionState,
  type ParsedNwcConnection,
  nonEmptyString,
  recordOrEmpty,
  type WalletCapabilitySummary,
} from "@openreceive/core";
import { HEX_64 } from "../hex.ts";
import { ReceiveCheckoutValidationError } from "./errors.ts";

export const REQUIRED_RECEIVE_METHODS = ["make_invoice", "list_transactions"] as const;
export const SPEND_METHODS = [
  "pay_invoice",
  "multi_pay_invoice",
  "pay_keysend",
  "multi_pay_keysend",
] as const;

/**
 * Normalized NWC-02 wallet notification. `transaction` is the notification
 * payload normalized exactly like a `list_transactions` row, so a settled
 * `payment_received` can settle its matching pending attempt directly —
 * notifications are authenticated wallet data. Logging still surfaces only
 * the type and the payment hash, never the payload.
 */
export interface NwcWalletNotification {
  readonly type: string;
  readonly payment_hash?: string;
  readonly transaction?: NwcTransaction;
}

export interface NormalizedListTransactions extends ListTransactionsResult {
  /** Rows the wallet returned that could not be normalized and were skipped. */
  readonly skippedRows: number;
}

/**
 * `rawInfo` is the method list that governs this connection (NIP-47
 * `get_info`, or the kind-13194 info event when that is all the client has).
 * `rawServiceInfo`, when given, is the info event: encryption is negotiated
 * service-wide, so its modes win over anything in `rawInfo`.
 */
export function summarizeWalletCapabilities(
  connection: ParsedNwcConnection,
  rawInfo: unknown,
  rawServiceInfo?: unknown,
): WalletCapabilitySummary {
  const unwrappedInfo = unwrapNwcResult(rawInfo);
  const info = recordOrEmpty(unwrappedInfo);
  const serviceInfo =
    rawServiceInfo === undefined ? undefined : recordOrEmpty(unwrapNwcResult(rawServiceInfo));
  const methods = normalizeStringList(
    info.methods ??
      info.capabilities ??
      info.supported_methods ??
      info.supportedMethods ??
      (typeof unwrappedInfo === "string" ? unwrappedInfo : undefined),
  ).map(normalizeNwcMethodName);
  const encryption = chooseEncryptionMode(
    normalizeStringList(
      serviceInfo?.encryption ?? serviceInfo?.encryptions ?? info.encryption ?? info.encryptions,
    ),
  );
  const spendMethods = spendMethodsIn(methods);
  const missingMethods = REQUIRED_RECEIVE_METHODS.filter((method) => !methods.includes(method));
  const warnings = spendMethods.map(
    (method) =>
      `Wallet advertises spend method '${method}'; OpenReceive checkout will not expose it.`,
  );

  return {
    walletPubkey: connection.walletPubkey,
    relays: [...connection.relays],
    methods,
    encryption,
    spendCapabilityAdvertised: spendMethods.length > 0,
    receiveCheckoutReady: missingMethods.length === 0,
    warnings,
  };
}

export function spendMethodsIn(methods: readonly string[]): string[] {
  return methods.filter((method) =>
    SPEND_METHODS.includes(method as (typeof SPEND_METHODS)[number]),
  );
}

export function toNip47MakeInvoiceParams(request: MakeInvoiceRequest): Record<string, unknown> {
  const params: Record<string, unknown> = {
    amount: toSafeNumber(request.amount_msats, "amount_msats"),
  };

  if (request.description !== undefined) params.description = request.description;
  if (request.description_hash !== undefined) {
    params.description_hash = request.description_hash;
  }
  if (request.expiry !== undefined) params.expiry = request.expiry;
  if (request.metadata !== undefined) params.metadata = request.metadata;

  return params;
}

export function toNip47ListTransactionsParams(
  request: ListTransactionsRequest,
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (request.from !== undefined) params.from = request.from;
  if (request.until !== undefined) params.until = request.until;
  if (request.limit !== undefined) params.limit = request.limit;
  if (request.offset !== undefined) params.offset = request.offset;
  if (request.unpaid !== undefined) params.unpaid = request.unpaid;
  if (request.type !== undefined) params.type = request.type;
  return params;
}

export function validateMakeInvoiceRequest(request: MakeInvoiceRequest): void {
  if (request.amount_msats < OPENRECEIVE_MIN_AMOUNT_MSATS) {
    throw new ReceiveCheckoutValidationError("amount_msats must be at least 1000");
  }

  if (request.amount_msats > OPENRECEIVE_MAX_AMOUNT_MSATS) {
    throw new ReceiveCheckoutValidationError("amount_msats exceeds JSON safe integer boundary");
  }

  if (request.description !== undefined && request.description_hash !== undefined) {
    throw new ReceiveCheckoutValidationError(
      "At most one of description or description_hash may be present",
    );
  }

  if (request.description_hash !== undefined && !HEX_64.test(request.description_hash)) {
    throw new ReceiveCheckoutValidationError("description_hash must be 64 hex characters");
  }

  if (request.metadata !== undefined) {
    const metadataBytes = byteLength(JSON.stringify(request.metadata));
    if (metadataBytes > OPENRECEIVE_NWC_METADATA_MAX_BYTES) {
      throw new ReceiveCheckoutValidationError(
        `metadata must serialize below ${OPENRECEIVE_NWC_METADATA_MAX_BYTES} bytes`,
      );
    }
  }
}

export function validateListTransactionsRequest(request: ListTransactionsRequest): void {
  validateOptionalNonNegativeInteger(request.from, "from");
  validateOptionalNonNegativeInteger(request.until, "until");
  validateOptionalNonNegativeInteger(request.offset, "offset");
  if (request.limit !== undefined && (!Number.isSafeInteger(request.limit) || request.limit <= 0)) {
    throw new ReceiveCheckoutValidationError("limit must be a positive safe integer");
  }
  if (request.from !== undefined && request.until !== undefined && request.from > request.until) {
    throw new ReceiveCheckoutValidationError("from must be less than or equal to until");
  }
  if (request.type !== undefined && request.type !== "incoming" && request.type !== "outgoing") {
    throw new ReceiveCheckoutValidationError("type must be incoming or outgoing");
  }
}

function validateOptionalNonNegativeInteger(value: number | undefined, field: string): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ReceiveCheckoutValidationError(`${field} must be a non-negative safe integer`);
  }
}

export function normalizeMakeInvoiceResult(rawResult: unknown): MakeInvoiceResult {
  const result = recordOrEmpty(unwrapNwcResult(rawResult));
  const invoice = requiredString(result.invoice, "invoice");
  const paymentHash = requiredString(result.payment_hash ?? result.paymentHash, "payment_hash");
  if (!HEX_64.test(paymentHash)) {
    throw new TypeError("payment_hash must be 64 hex characters");
  }
  // amount_msats is read BEFORE the optional timestamps so that a wallet
  // returning several malformed fields at once still hears about the amount
  // first — the field that decides what is owed. Hoisting the timestamp reads
  // above this line would silently reorder that precedence.
  const amountMsats = toBigInt(result.amount_msats ?? result.amount, "amount_msats");
  const createdAt = parseOptionalInteger(result.created_at ?? result.createdAt, "created_at");
  const expiresAt = parseOptionalInteger(result.expires_at ?? result.expiresAt, "expires_at");

  return {
    invoice,
    payment_hash: paymentHash,
    amount_msats: amountMsats,
    ...(createdAt === undefined ? {} : { created_at: createdAt }),
    ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
  };
}

export function normalizeListTransactionsResult(rawResult: unknown): NormalizedListTransactions {
  const unwrapped = unwrapNwcResult(rawResult);
  const result = recordOrEmpty(unwrapped);
  let rawTransactions: readonly unknown[];
  if (Array.isArray(result.transactions)) {
    rawTransactions = result.transactions;
  } else if (Array.isArray(unwrapped)) {
    rawTransactions = unwrapped;
  } else if (
    (unwrapped === undefined || unwrapped === null || typeof unwrapped === "object") &&
    Object.keys(result).length === 0
  ) {
    // A genuinely empty reply is an empty scan.
    rawTransactions = [];
  } else {
    // A non-empty reply in a shape we do not recognize must NOT read as an
    // empty scan: an empty-looking scan at/after expiry+grace closes pending
    // attempts as expired, so a custom client returning rows under another
    // key could get paid invoices closed. Fail the scan loudly instead.
    throw new TypeError("list_transactions returned an unrecognized result shape");
  }
  // One quirky wallet row must never reject the whole scan: reconciliation
  // depends on every pass succeeding, and a rejected scan can neither settle
  // nor close pending attempts (a permanent livelock while the bad row stays
  // inside the scan window). Bad rows are skipped and surfaced via skippedRows.
  const transactions: NwcTransaction[] = [];
  let skippedRows = 0;
  for (const rawTransaction of rawTransactions) {
    try {
      transactions.push(normalizeNwcTransaction(rawTransaction));
    } catch {
      skippedRows += 1;
    }
  }
  return { transactions, skippedRows };
}

export function normalizeNwcTransaction(rawTransaction: unknown): NwcTransaction {
  const result = recordOrEmpty(rawTransaction);
  const normalized: NwcTransaction = {};

  const type = normalizeTransactionType(result.type);
  if (type !== undefined) normalized.type = type;

  // Per-field tolerance: a wallet's odd field (empty string, float timestamp,
  // unparsable amount) degrades to "field absent" rather than rejecting the
  // row — settlement classification already treats missing fields safely.
  const invoice = nonEmptyString(result.invoice);
  if (invoice !== undefined) normalized.invoice = invoice;
  const paymentHash = nonEmptyString(result.payment_hash ?? result.paymentHash);
  if (paymentHash !== undefined) normalized.payment_hash = paymentHash;
  try {
    if (result.amount_msats !== undefined || result.amount !== undefined) {
      normalized.amount_msats = toBigInt(result.amount_msats ?? result.amount, "amount_msats");
    }
  } catch {
    // Unparsable amount: leave the field absent.
  }

  // Map common wallet-library field spellings to OpenReceive's normalized
  // transaction_state at the adapter boundary.
  const transactionState =
    normalizeTransactionState(
      result.transaction_state ?? result.transactionState ?? result.state,
    ) ?? (result.settled === true || result.paid === true ? "settled" : undefined);
  if (transactionState !== undefined) {
    normalized.transaction_state = transactionState;
  }

  const createdAt = optionalUnixSeconds(result.created_at ?? result.createdAt);
  if (createdAt !== undefined) normalized.created_at = createdAt;
  const expiresAt = optionalUnixSeconds(result.expires_at ?? result.expiresAt);
  if (expiresAt !== undefined) normalized.expires_at = expiresAt;
  const settledAt = optionalUnixSeconds(result.settled_at ?? result.settledAt);
  if (settledAt !== undefined) normalized.settled_at = settledAt;

  const preimage = nonEmptyString(result.preimage);
  if (preimage !== undefined) normalized.preimage = preimage;
  const description = nonEmptyString(result.description);
  if (description !== undefined) normalized.description = description;
  const descriptionHash = nonEmptyString(result.description_hash ?? result.descriptionHash);
  if (descriptionHash !== undefined) normalized.description_hash = descriptionHash;
  try {
    if (result.fees_paid !== undefined || result.feesPaid !== undefined) {
      normalized.fees_paid_msats = toBigInt(result.fees_paid ?? result.feesPaid, "fees_paid");
    }
  } catch {
    // Unparsable fee: leave the field absent.
  }

  return normalized;
}

export function normalizeNwcNotification(rawNotification: unknown): NwcWalletNotification {
  const record = recordOrEmpty(rawNotification);
  const type =
    typeof record.notification_type === "string"
      ? record.notification_type
      : typeof record.notificationType === "string"
        ? record.notificationType
        : typeof record.type === "string"
          ? record.type
          : "unknown";
  const payload = recordOrEmpty(record.notification);
  let transaction: NwcTransaction | undefined;
  if (Object.keys(payload).length > 0) {
    try {
      transaction = normalizeNwcTransaction(payload);
    } catch {
      // A malformed payload never settles anything and never breaks the
      // subscription; the hash (when present) still wakes reconciliation.
    }
  }
  const rawHash =
    payload.payment_hash ?? payload.paymentHash ?? record.payment_hash ?? record.paymentHash;
  const paymentHash =
    typeof rawHash === "string" && rawHash.length > 0 ? rawHash : transaction?.payment_hash;
  return {
    type,
    ...(paymentHash === undefined ? {} : { payment_hash: paymentHash }),
    ...(transaction === undefined ? {} : { transaction }),
  };
}

function chooseEncryptionMode(encryptionModes: string[]): NwcEncryptionMode | undefined {
  const normalized = encryptionModes.map((mode) => mode.toLowerCase().replace(/[- ]/g, "_"));

  if (
    normalized.includes("nip44_v2") ||
    normalized.includes("nip44") ||
    normalized.includes("nip_44")
  ) {
    return "nip44_v2";
  }
  // No advertised list at all: assume the NIP-47 baseline (NIP-04).
  if (normalized.length === 0 || normalized.includes("nip04") || normalized.includes("nip_04")) {
    return "nip04";
  }
  // The wallet advertises encryption modes and none of them is one we speak
  // (e.g. a future nip44_v3-only wallet): let preflight fail loudly instead of
  // failing cryptically at RPC time.
  return undefined;
}

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function normalizeNwcMethodName(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

function normalizeTransactionState(value: unknown): TransactionState | undefined {
  if (typeof value !== "string") return undefined;

  const normalized = value.toLowerCase();
  if (
    normalized === "pending" ||
    normalized === "settled" ||
    normalized === "expired" ||
    normalized === "failed" ||
    normalized === "accepted"
  ) {
    return normalized;
  }

  return undefined;
}

function normalizeTransactionType(value: unknown): "incoming" | "outgoing" | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase();
  if (normalized === "incoming" || normalized === "outgoing") return normalized;
  return undefined;
}

/** Absent stays absent; anything present must be a non-negative safe integer. */
function parseOptionalInteger(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null) return undefined;

  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a non-negative safe integer`);
  }

  return value;
}

/**
 * Timestamp reader for wallet-supplied scan rows: floors float seconds (some
 * wallets report fractional settled_at) and degrades anything unusable to
 * undefined instead of rejecting the row.
 */
function optionalUnixSeconds(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

function requiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }

  return value;
}

function toBigInt(value: unknown, fieldName: string): bigint {
  if (typeof value === "bigint") return value;

  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return BigInt(value);
  }

  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    return BigInt(value);
  }

  throw new TypeError(`${fieldName} must be an integer`);
}

function toSafeNumber(value: bigint, fieldName: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ReceiveCheckoutValidationError(`${fieldName} exceeds JSON safe integer boundary`);
  }

  return Number(value);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function unwrapNwcResult(value: unknown): unknown {
  const record = recordOrEmpty(value);
  return record.result ?? value;
}
