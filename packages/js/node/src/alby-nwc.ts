import {
  OPENRECEIVE_MAX_AMOUNT_MSATS,
  OPENRECEIVE_MIN_AMOUNT_MSATS,
  OPENRECEIVE_NWC_METADATA_MAX_BYTES,
  type LookupInvoiceRequest,
  type LookupInvoiceResult,
  type MakeInvoiceRequest,
  type MakeInvoiceResult,
  type NwcEncryptionMode,
  type OpenReceiveReceiveNwcClient,
  type OpenReceiveTransactionState,
  type PaymentReceivedNotification,
  type ParsedNwcConnection,
  type WalletCapabilitySummary,
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
    const rawInfo =
      typeof client.getWalletServiceInfo === "function"
        ? await client.getWalletServiceInfo()
        : await callRequiredMethod(client, ["getInfo", "get_info"], {});
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

    const rawResult = await callRequiredMethod(
      await this.getClient(),
      ["makeInvoice", "make_invoice"],
      toNip47MakeInvoiceParams(request)
    );

    return normalizeMakeInvoiceResult(rawResult);
  }

  async lookupInvoice(request: LookupInvoiceRequest): Promise<LookupInvoiceResult> {
    await this.ensurePreflight();
    validateLookupInvoiceRequest(request);

    const rawResult = await callRequiredMethod(
      await this.getClient(),
      ["lookupInvoice", "lookup_invoice"],
      toNip47LookupInvoiceParams(request)
    );

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

    const unsubscribe = await client.subscribeNotifications((rawNotification) => {
      const notification = normalizePaymentReceivedNotification(rawNotification);
      if (notification !== undefined) void handler(notification);
    }, ["payment_received"]);

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
    const method = client[name];
    if (typeof method === "function") {
      return await method.call(client, request);
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
  const Constructor = namespace.NWCClient;

  if (typeof Constructor !== "function") {
    throw new WalletPreflightError(
      "wallet_unavailable",
      "@getalby/sdk/nwc did not expose NWCClient."
    );
  }

  return new Constructor({
    nostrWalletConnectUrl: connectionString
  }) as AlbyNwcCompatibleClient;
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
