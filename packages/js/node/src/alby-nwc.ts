import {
  OPENRECEIVE_MAX_AMOUNT_MSATS,
  OPENRECEIVE_MIN_AMOUNT_MSATS,
  OPENRECEIVE_NWC_METADATA_MAX_BYTES,
  OpenReceiveError,
  type LookupInvoiceRequest,
  type LookupInvoiceResult,
  type MakeInvoiceRequest,
  type MakeInvoiceResult,
  type NwcEncryptionMode,
  type OpenReceiveErrorBody,
  type OpenReceiveErrorCode,
  type OpenReceiveReceiveNwcClient,
  type OpenReceiveTransactionState,
  type PaymentReceivedNotification,
  type ParsedNwcConnection,
  type WalletCapabilitySummary,
  isOpenReceiveErrorCode,
  isRetryableOpenReceiveErrorCode,
  parseNwcUri
} from "@openreceive/core";

const REQUIRED_RECEIVE_METHODS = ["make_invoice", "lookup_invoice"] as const;
const SPEND_METHODS = [
  "pay_invoice",
  "multi_pay_invoice",
  "pay_keysend",
  "multi_pay_keysend"
] as const;

export interface AlbyNwcCompatibleClient {
  getInfo?: () => Promise<unknown>;
  get_info?: () => Promise<unknown>;
  getWalletServiceInfo?: () => Promise<unknown>;
  makeInvoice?: (request: Record<string, unknown>) => Promise<unknown>;
  make_invoice?: (request: Record<string, unknown>) => Promise<unknown>;
  lookupInvoice?: (request: Record<string, unknown>) => Promise<unknown>;
  lookup_invoice?: (request: Record<string, unknown>) => Promise<unknown>;
  subscribeNotifications?: (
    handler: (notification: unknown) => void,
    notificationTypes?: string[]
  ) => Promise<() => void> | (() => void);
  close?: () => Promise<void> | void;
}

export type AlbyNwcClientFactory = (
  connection: ParsedNwcConnection
) => Promise<AlbyNwcCompatibleClient> | AlbyNwcCompatibleClient;

export interface AlbyNwcReceiveClientOptions {
  connectionString: string;
  client?: AlbyNwcCompatibleClient;
  clientFactory?: AlbyNwcClientFactory;
  requirePreflight?: boolean;
}

export type WalletPreflightErrorCode =
  | "missing_required_method"
  | "unsupported_encryption"
  | "wallet_unavailable";

export class WalletPreflightError extends Error {
  readonly code: WalletPreflightErrorCode;
  readonly summary?: WalletCapabilitySummary;

  constructor(
    code: WalletPreflightErrorCode,
    message: string,
    summary?: WalletCapabilitySummary
  ) {
    super(message);
    this.name = "WalletPreflightError";
    this.code = code;
    this.summary = summary;
  }
}

export class ReceiveCheckoutValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiveCheckoutValidationError";
  }
}

export class AlbyNwcReceiveClient implements OpenReceiveReceiveNwcClient {
  readonly connection: ParsedNwcConnection;

  #connectionString: string;
  #client?: AlbyNwcCompatibleClient;
  #clientFactory?: AlbyNwcClientFactory;
  #preflightSummary?: WalletCapabilitySummary;
  #requirePreflight: boolean;

  constructor(options: AlbyNwcReceiveClientOptions) {
    this.#connectionString = options.connectionString;
    this.connection = parseNwcUri(options.connectionString);
    this.#client = options.client;
    this.#clientFactory = options.clientFactory;
    this.#requirePreflight = options.requirePreflight ?? true;
  }

  async preflight(): Promise<WalletCapabilitySummary> {
    const client = await this.getClient();
    let rawInfo: unknown;
    try {
      rawInfo =
        typeof client.getWalletServiceInfo === "function"
          ? await client.getWalletServiceInfo()
          : await callRequiredMethod(client, ["getInfo", "get_info"], {});
    } catch (error) {
      throw normalizeNwcWalletError(error);
    }
    const summary = summarizeWalletCapabilities(this.connection, rawInfo);

    this.#preflightSummary = summary;

    if (!summary.receiveCheckoutReady) {
      throw new WalletPreflightError(
        "missing_required_method",
        "NWC wallet must advertise make_invoice and lookup_invoice for receive checkout.",
        summary
      );
    }

    if (summary.encryption !== "nip04" && summary.encryption !== "nip44_v2") {
      throw new WalletPreflightError(
        "unsupported_encryption",
        "NWC wallet must support NIP-04 or NIP-44 v2 encryption.",
        summary
      );
    }

    return summary;
  }

  async makeInvoice(request: MakeInvoiceRequest): Promise<MakeInvoiceResult> {
    await this.ensurePreflight();
    validateMakeInvoiceRequest(request);

    let rawResult: unknown;
    try {
      rawResult = await callRequiredMethod(
        await this.getClient(),
        ["makeInvoice", "make_invoice"],
        toNip47MakeInvoiceParams(request)
      );
    } catch (error) {
      throw normalizeNwcWalletError(error);
    }

    return normalizeMakeInvoiceResult(rawResult);
  }

  async lookupInvoice(request: LookupInvoiceRequest): Promise<LookupInvoiceResult> {
    await this.ensurePreflight();
    validateLookupInvoiceRequest(request);

    let rawResult: unknown;
    try {
      rawResult = await callRequiredMethod(
        await this.getClient(),
        ["lookupInvoice", "lookup_invoice"],
        toNip47LookupInvoiceParams(request)
      );
    } catch (error) {
      throw normalizeNwcWalletError(error);
    }

    return normalizeLookupInvoiceResult(rawResult);
  }

  async close(): Promise<void> {
    await this.#client?.close?.();
  }

  async subscribeToPaymentReceived(
    handler: (notification: PaymentReceivedNotification) => Promise<void> | void
  ): Promise<() => Promise<void> | void> {
    await this.ensurePreflight();
    const client = await this.getClient();

    if (typeof client.subscribeNotifications !== "function") {
      throw new WalletPreflightError(
        "wallet_unavailable",
        "NWC client does not expose payment_received notification subscription."
      );
    }

    let unsubscribe: () => void | Promise<void>;
    try {
      unsubscribe = await client.subscribeNotifications((rawNotification) => {
        const notification = normalizePaymentReceivedNotification(rawNotification);
        if (notification !== undefined) void handler(notification);
      }, ["payment_received"]);
    } catch (error) {
      throw normalizeNwcWalletError(error);
    }

    return unsubscribe;
  }

  private async ensurePreflight(): Promise<void> {
    if (!this.#requirePreflight || this.#preflightSummary !== undefined) return;
    await this.preflight();
  }

  private async getClient(): Promise<AlbyNwcCompatibleClient> {
    if (this.#client !== undefined) return this.#client;

    if (this.#clientFactory !== undefined) {
      this.#client = await this.#clientFactory(this.connection);
      return this.#client;
    }

    this.#client = await createDefaultAlbyNwcClient(this.#connectionString);
    return this.#client;
  }
}

export function createAlbyNwcReceiveClient(
  options: AlbyNwcReceiveClientOptions
): AlbyNwcReceiveClient {
  return new AlbyNwcReceiveClient(options);
}

export function normalizeNwcWalletError(error: unknown): OpenReceiveError {
  if (error instanceof OpenReceiveError) return error;

  const records = collectErrorRecords(error);
  const code =
    knownOpenReceiveErrorCode(error) ??
    errorCodeFromRecords(records) ??
    (typeof error === "string" ? normalizeNwcErrorCode(error) : undefined) ??
    "OTHER";
  const message = errorMessageFromRecords(records, error, code);
  const retryable =
    firstBooleanField(records, ["retryable"]) ??
    isRetryableOpenReceiveErrorCode(code);
  const requestId = firstStringField(records, ["request_id", "requestId"]);
  const details = firstRecordField(records, ["details"]);
  const body: OpenReceiveErrorBody = {
    code,
    message,
    retryable,
    ...(requestId === undefined ? {} : { request_id: requestId }),
    ...(details === undefined ? {} : { details })
  };

  return new OpenReceiveError(body, { cause: error });
}

export function summarizeWalletCapabilities(
  connection: ParsedNwcConnection,
  rawInfo: unknown
): WalletCapabilitySummary {
  const unwrappedInfo = unwrapNwcResult(rawInfo);
  const info = asRecord(unwrappedInfo);
  const methods = normalizeStringList(
    info.methods ??
      info.capabilities ??
      info.supported_methods ??
      info.supportedMethods ??
      (typeof unwrappedInfo === "string" ? unwrappedInfo : undefined)
  ).map(normalizeNwcMethodName);
  const notifications = normalizeStringList(
    info.notifications ??
      info.notification_types ??
      info.notificationTypes
  );
  const encryption = chooseEncryptionMode(
    normalizeStringList(info.encryption ?? info.encryptions)
  );
  const spendMethods = methods.filter((method) =>
    SPEND_METHODS.includes(method as (typeof SPEND_METHODS)[number])
  );
  const missingMethods = REQUIRED_RECEIVE_METHODS.filter(
    (method) => !methods.includes(method)
  );
  const warnings = spendMethods.map(
    (method) => `Wallet advertises spend method '${method}'; OpenReceive checkout will not expose it.`
  );

  return {
    walletPubkey: connection.walletPubkey,
    relays: [...connection.relays],
    methods,
    notifications,
    encryption,
    spendCapabilityAdvertised: spendMethods.length > 0,
    receiveCheckoutReady: missingMethods.length === 0,
    warnings
  };
}

function toNip47MakeInvoiceParams(
  request: MakeInvoiceRequest
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    amount: toSafeNumber(request.amount_msats, "amount_msats")
  };

  if (request.description !== undefined) params.description = request.description;
  if (request.description_hash !== undefined) {
    params.description_hash = request.description_hash;
  }
  if (request.expiry !== undefined) params.expiry = request.expiry;
  if (request.metadata !== undefined) params.metadata = request.metadata;

  return params;
}

function toNip47LookupInvoiceParams(
  request: LookupInvoiceRequest
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (request.payment_hash !== undefined) params.payment_hash = request.payment_hash;
  if (request.invoice !== undefined) params.invoice = request.invoice;
  return params;
}

function validateMakeInvoiceRequest(request: MakeInvoiceRequest): void {
  if (request.amount_msats < OPENRECEIVE_MIN_AMOUNT_MSATS) {
    throw new ReceiveCheckoutValidationError("amount_msats must be at least 1000");
  }

  if (request.amount_msats > OPENRECEIVE_MAX_AMOUNT_MSATS) {
    throw new ReceiveCheckoutValidationError(
      "amount_msats exceeds JSON safe integer boundary"
    );
  }

  if (
    request.description !== undefined &&
    request.description_hash !== undefined
  ) {
    throw new ReceiveCheckoutValidationError(
      "Exactly one of description or description_hash may be present"
    );
  }

  if (request.metadata !== undefined) {
    const metadataBytes = byteLength(JSON.stringify(request.metadata));
    if (metadataBytes > OPENRECEIVE_NWC_METADATA_MAX_BYTES) {
      throw new ReceiveCheckoutValidationError(
        `metadata must serialize below ${OPENRECEIVE_NWC_METADATA_MAX_BYTES} bytes`
      );
    }
  }
}

function validateLookupInvoiceRequest(request: LookupInvoiceRequest): void {
  const hasPaymentHash = request.payment_hash !== undefined;
  const hasInvoice = request.invoice !== undefined;

  if (hasPaymentHash === hasInvoice) {
    throw new ReceiveCheckoutValidationError(
      "lookupInvoice requires exactly one of payment_hash or invoice"
    );
  }
}

function normalizeMakeInvoiceResult(rawResult: unknown): MakeInvoiceResult {
  const result = asRecord(unwrapNwcResult(rawResult));
  const invoice = requiredString(result.invoice, "invoice");
  const paymentHash = requiredString(
    result.payment_hash ?? result.paymentHash,
    "payment_hash"
  );
  const rawAmount = result.amount_msats ?? result.amount;

  return {
    invoice,
    payment_hash: paymentHash,
    amount_msats: toBigInt(rawAmount, "amount_msats"),
    ...optionalNumberField(result.created_at ?? result.createdAt, "created_at"),
    ...optionalNumberField(result.expires_at ?? result.expiresAt, "expires_at")
  };
}

function normalizeLookupInvoiceResult(rawResult: unknown): LookupInvoiceResult {
  const result = asRecord(unwrapNwcResult(rawResult));
  const normalized: LookupInvoiceResult = {};

  if (result.invoice !== undefined) {
    normalized.invoice = requiredString(result.invoice, "invoice");
  }
  if (result.payment_hash !== undefined || result.paymentHash !== undefined) {
    normalized.payment_hash = requiredString(
      result.payment_hash ?? result.paymentHash,
      "payment_hash"
    );
  }
  if (result.amount_msats !== undefined || result.amount !== undefined) {
    normalized.amount_msats = toBigInt(
      result.amount_msats ?? result.amount,
      "amount_msats"
    );
  }

  const state = normalizeTransactionState(result.state);
  const transactionState = normalizeTransactionState(
    result.transaction_state ?? result.transactionState
  );
  if (state !== undefined) normalized.state = state;
  if (transactionState !== undefined) {
    normalized.transaction_state = transactionState;
  }

  Object.assign(
    normalized,
    optionalNumberField(result.created_at ?? result.createdAt, "created_at"),
    optionalNumberField(result.expires_at ?? result.expiresAt, "expires_at"),
    optionalNumberField(result.settled_at ?? result.settledAt, "settled_at")
  );

  if (result.preimage !== undefined) {
    normalized.preimage = requiredString(result.preimage, "preimage");
  }

  return normalized;
}

async function callRequiredMethod(
  client: AlbyNwcCompatibleClient,
  names: readonly (keyof AlbyNwcCompatibleClient)[],
  request: Record<string, unknown>
): Promise<unknown> {
  for (const name of names) {
    const method = client[name] as unknown;
    if (typeof method === "function") {
      return await (method as (request: Record<string, unknown>) => Promise<unknown>).call(client, request);
    }
  }

  throw new WalletPreflightError(
    "wallet_unavailable",
    `NWC client does not expose ${names.join(" or ")}.`
  );
}

async function createDefaultAlbyNwcClient(
  connectionString: string
): Promise<AlbyNwcCompatibleClient> {
  const dynamicImport = new Function(
    "specifier",
    "return import(specifier)"
  ) as (specifier: string) => Promise<unknown>;
  const namespace = asRecord(await dynamicImport("@getalby/sdk/nwc"));
  const Constructor = namespace.NWCClient as unknown;

  if (typeof Constructor !== "function") {
    throw new WalletPreflightError(
      "wallet_unavailable",
      "@getalby/sdk/nwc did not expose NWCClient."
    );
  }

  const NWCClientConstructor = Constructor as new (options: {
    nostrWalletConnectUrl: string;
  }) => AlbyNwcCompatibleClient;

  return new NWCClientConstructor({
    nostrWalletConnectUrl: connectionString
  });
}

const NWC_ERROR_CODE_ALIASES: Readonly<Record<string, OpenReceiveErrorCode>> = {
  ABORT_ERROR: "TIMEOUT",
  BAD_REQUEST: "INVALID_REQUEST",
  CONNECTION_ERROR: "WALLET_UNAVAILABLE",
  EXPIRED: "INVOICE_EXPIRED",
  FETCH_ERROR: "WALLET_UNAVAILABLE",
  FORBIDDEN: "RESTRICTED",
  INVOICE_NOT_FOUND: "NOT_FOUND",
  INVALID_PARAMETER: "INVALID_REQUEST",
  INVALID_PARAMETERS: "INVALID_REQUEST",
  INVALID_PARAMS: "INVALID_REQUEST",
  METHOD_NOT_FOUND: "UNSUPPORTED_METHOD",
  NETWORK_ERROR: "WALLET_UNAVAILABLE",
  NOT_AUTHORIZED: "UNAUTHORIZED",
  NOT_SUPPORTED: "UNSUPPORTED_METHOD",
  NOTFOUND: "NOT_FOUND",
  PERMISSION_DENIED: "RESTRICTED",
  REQUEST_TIMEOUT: "TIMEOUT",
  SERVICE_UNAVAILABLE: "WALLET_UNAVAILABLE",
  TIMED_OUT: "TIMEOUT",
  TIMEOUT_ERROR: "TIMEOUT",
  UNKNOWN_METHOD: "UNSUPPORTED_METHOD",
  UNSUPPORTED: "UNSUPPORTED_METHOD",
  UNSUPPORTED_ENCRYPTION_MODE: "UNSUPPORTED_ENCRYPTION",
  WALLET_OFFLINE: "WALLET_UNAVAILABLE",
  WALLET_UNREACHABLE: "WALLET_UNAVAILABLE"
};

const OPENRECEIVE_ERROR_MESSAGES = {
  NOT_IMPLEMENTED: "NWC wallet service does not implement this method.",
  RESTRICTED: "NWC wallet service restricted this request.",
  UNAUTHORIZED: "NWC wallet service rejected authorization.",
  RATE_LIMITED: "NWC wallet service rate limited this request.",
  QUOTA_EXCEEDED: "NWC wallet service quota was exceeded.",
  INTERNAL: "NWC wallet service returned an internal error.",
  UNSUPPORTED_ENCRYPTION: "NWC wallet service does not support the required encryption mode.",
  INSUFFICIENT_BALANCE: "NWC wallet reported insufficient balance.",
  PAYMENT_FAILED: "NWC wallet reported payment failure.",
  OTHER: "NWC wallet service returned an unknown error.",
  NOT_FOUND: "NWC wallet service could not find the requested resource.",
  TIMEOUT: "NWC wallet service request timed out.",
  INVALID_REQUEST: "OpenReceive sent an invalid NWC wallet request.",
  WALLET_UNAVAILABLE: "NWC wallet service is unavailable.",
  INVOICE_EXPIRED: "NWC wallet reported that the invoice is expired.",
  UNSUPPORTED_METHOD: "NWC wallet service does not support the requested method.",
  CONFLICT: "NWC wallet service reported a conflicting request."
} satisfies Record<OpenReceiveErrorCode, string>;

function knownOpenReceiveErrorCode(
  error: unknown
): OpenReceiveErrorCode | undefined {
  if (error instanceof ReceiveCheckoutValidationError) {
    return "INVALID_REQUEST";
  }

  if (error instanceof WalletPreflightError) {
    if (error.code === "missing_required_method") return "UNSUPPORTED_METHOD";
    if (error.code === "unsupported_encryption") return "UNSUPPORTED_ENCRYPTION";
    return "WALLET_UNAVAILABLE";
  }

  return undefined;
}

function errorCodeFromRecords(
  records: readonly Record<string, unknown>[]
): OpenReceiveErrorCode | undefined {
  for (const record of records) {
    const code =
      normalizeNwcErrorCode(record.code) ??
      normalizeNwcErrorCode(record.error_code) ??
      normalizeNwcErrorCode(record.errorCode) ??
      normalizeNwcErrorCode(record.type) ??
      normalizeNwcErrorCode(record.name);
    if (code !== undefined) return code;
  }

  return undefined;
}

function normalizeNwcErrorCode(value: unknown): OpenReceiveErrorCode | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;

  const normalized = normalizeNwcErrorCodeText(value);
  if (isOpenReceiveErrorCode(normalized)) return normalized;
  return NWC_ERROR_CODE_ALIASES[normalized];
}

function normalizeNwcErrorCodeText(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function errorMessageFromRecords(
  records: readonly Record<string, unknown>[],
  error: unknown,
  code: OpenReceiveErrorCode
): string {
  const message = firstStringField(records, [
    "message",
    "description",
    "reason"
  ]);
  if (message !== undefined && normalizeNwcErrorCode(message) !== code) {
    return message;
  }

  if (typeof error === "string" && normalizeNwcErrorCode(error) === undefined) {
    const trimmed = error.trim();
    if (trimmed.length > 0) return trimmed;
  }

  return OPENRECEIVE_ERROR_MESSAGES[code];
}

function collectErrorRecords(value: unknown): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  collectErrorRecordsInto(value, records, new Set<object>());
  return records;
}

function collectErrorRecordsInto(
  value: unknown,
  records: Record<string, unknown>[],
  seen: Set<object>
): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;

  seen.add(value);
  const record = value as Record<string, unknown>;
  records.push(record);

  for (const key of ["error", "result", "cause", "data"]) {
    collectErrorRecordsInto(record[key], records, seen);
  }
}

function firstStringField(
  records: readonly Record<string, unknown>[],
  fields: readonly string[]
): string | undefined {
  for (const record of records) {
    for (const field of fields) {
      const value = record[field];
      if (typeof value === "string" && value.trim().length > 0) {
        return value;
      }
    }
  }

  return undefined;
}

function firstBooleanField(
  records: readonly Record<string, unknown>[],
  fields: readonly string[]
): boolean | undefined {
  for (const record of records) {
    for (const field of fields) {
      const value = record[field];
      if (typeof value === "boolean") return value;
    }
  }

  return undefined;
}

function firstRecordField(
  records: readonly Record<string, unknown>[],
  fields: readonly string[]
): Record<string, unknown> | undefined {
  for (const record of records) {
    for (const field of fields) {
      const value = record[field];
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    }
  }

  return undefined;
}

function chooseEncryptionMode(encryptionModes: string[]): NwcEncryptionMode {
  const normalized = encryptionModes.map((mode) =>
    mode.toLowerCase().replace(/[- ]/g, "_")
  );

  if (
    normalized.includes("nip44_v2") ||
    normalized.includes("nip44") ||
    normalized.includes("nip_44")
  ) {
    return "nip44_v2";
  }

  return "nip04";
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

function normalizeTransactionState(
  value: unknown
): OpenReceiveTransactionState | undefined {
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

function normalizePaymentReceivedNotification(
  rawNotification: unknown
): PaymentReceivedNotification | undefined {
  const notification = asRecord(unwrapNwcResult(rawNotification));
  const type = notification.notification_type ?? notification.notificationType;
  if (type !== "payment_received") return undefined;

  const transaction = asRecord(notification.notification);
  const paymentHash = transaction.payment_hash ?? transaction.paymentHash;
  if (typeof paymentHash !== "string" || paymentHash.length === 0) {
    return undefined;
  }

  const normalized: PaymentReceivedNotification = {
    payment_hash: paymentHash,
    raw: rawNotification
  };

  if (typeof transaction.invoice === "string") {
    normalized.invoice = transaction.invoice;
  }

  if (transaction.amount !== undefined || transaction.amount_msats !== undefined) {
    normalized.amount_msats = toBigInt(
      transaction.amount_msats ?? transaction.amount,
      "amount_msats"
    );
  }

  if (
    typeof transaction.settled_at === "number" &&
    Number.isSafeInteger(transaction.settled_at)
  ) {
    normalized.settled_at = transaction.settled_at;
  }

  return normalized;
}

function optionalNumberField(
  value: unknown,
  fieldName: string
): Record<string, number> {
  if (value === undefined || value === null) return {};

  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a non-negative safe integer`);
  }

  return { [fieldName]: value };
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
    throw new ReceiveCheckoutValidationError(
      `${fieldName} exceeds JSON safe integer boundary`
    );
  }

  return Number(value);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) return {};
  return value as Record<string, unknown>;
}

function unwrapNwcResult(value: unknown): unknown {
  const record = asRecord(value);
  return record.result ?? value;
}
