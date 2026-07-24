export const OPENRECEIVE_NWC_METADATA_MAX_BYTES = 3900 as const;
export const NWC_URI_PROTOCOL = "nostr+walletconnect:" as const;
export const NWC_REDACTED_SECRET = "[REDACTED]" as const;
export const OPENRECEIVE_NWC_CODE_HELP_URL =
  "https://openreceive.org/get_a_nwc_code_to_receive_payments" as const;

const HEX_64 = /^[0-9a-fA-F]{64}$/;

export type NwcEncryptionMode = "nip04" | "nip44_v2";

export type NwcUriParseErrorCode =
  | "invalid_uri"
  | "invalid_scheme"
  | "missing_wallet_pubkey"
  | "invalid_wallet_pubkey"
  | "missing_relay"
  | "invalid_relay"
  | "missing_secret"
  | "invalid_secret";

export class NwcUriParseError extends Error {
  readonly code: NwcUriParseErrorCode;
  readonly description: string;
  readonly redacted?: string;

  constructor(code: NwcUriParseErrorCode, description: string, uri?: string) {
    super(code);
    this.name = "NwcUriParseError";
    this.code = code;
    this.description = description;
    this.redacted = uri === undefined ? undefined : redactNwcUri(uri);
  }
}

export function formatOpenReceiveMissingNwcMessage(
  input: { readonly subject?: string } = {},
): string {
  const subject = input.subject ?? "OpenReceive";
  return [
    `${subject} needs a receive-only NWC code to receive payments.`,
    "Set NWC_URI to your receive-only Nostr Wallet Connect connection string.",
    `Get one here: ${OPENRECEIVE_NWC_CODE_HELP_URL}`,
  ].join("\n");
}

export function formatOpenReceiveInvalidNwcMessage(
  input: { readonly reason?: string } = {},
): string {
  return [
    "`nwc` is set, but it is not a valid NWC code.",
    input.reason === undefined ? undefined : `Reason: ${input.reason}`,
    `Get a receive-only NWC code here: ${OPENRECEIVE_NWC_CODE_HELP_URL}`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

/**
 * Loud console warning when the NIP-47 info event advertises send-payment methods
 * such as `pay_invoice`. OpenReceive still boots after this message.
 */
export function formatOpenReceiveSpendCapabilityWarningMessage(
  input: { readonly spendMethods?: readonly string[] } = {},
): string {
  const methods =
    input.spendMethods === undefined || input.spendMethods.length === 0
      ? ["pay_invoice"]
      : [...input.spendMethods];
  const listed = methods.join(", ");
  return [
    "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
    "ERROR: This NWC connection is NOT receive-only.",
    `The wallet info event advertises spend method(s): ${listed}.`,
    "OpenReceive must use a receive-only NWC code (no pay_invoice).",
    `Get a receive-only NWC code here: ${OPENRECEIVE_NWC_CODE_HELP_URL}`,
    "Continuing to boot in 5 seconds so you can read this...",
    "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
  ].join("\n");
}

export type OpenReceiveTransactionState = "pending" | "settled" | "expired" | "failed" | "accepted";

export type OpenReceiveWorkflowState =
  | "draft"
  | "invoice_created"
  | "verifying"
  | "paid"
  | "expired"
  | "failed"
  | "cancelled";

export interface ParsedNwcConnection {
  walletPubkey: string;
  relays: string[];
  clientSecret: string;
  lud16?: string;
  redacted: string;
}

export interface WalletCapabilitySummary {
  walletPubkey: string;
  relays: string[];
  methods: string[];
  encryption: NwcEncryptionMode;
  spendCapabilityAdvertised: boolean;
  receiveCheckoutReady: boolean;
  warnings: string[];
}

export interface MakeInvoiceRequest {
  amount_msats: bigint;
  description?: string;
  description_hash?: string;
  expiry?: number;
  metadata?: Record<string, unknown>;
}

export interface MakeInvoiceResult {
  invoice: string;
  payment_hash: string;
  amount_msats: bigint;
  created_at?: number;
  expires_at?: number;
}

export interface ListTransactionsRequest {
  from?: number;
  until?: number;
  limit?: number;
  offset?: number;
  unpaid?: boolean;
  type?: "incoming" | "outgoing";
}

export interface NwcTransaction {
  type?: "incoming" | "outgoing";
  invoice?: string;
  payment_hash?: string;
  amount_msats?: bigint;
  transaction_state?: OpenReceiveTransactionState;
  state?: OpenReceiveTransactionState;
  created_at?: number;
  expires_at?: number;
  settled_at?: number;
  preimage?: string;
  fees_paid_msats?: bigint;
  description?: string;
  description_hash?: string;
}

export interface ListTransactionsResult {
  transactions: NwcTransaction[];
}

export interface OpenReceiveReceiveNwcClient {
  preflight(): Promise<WalletCapabilitySummary>;
  makeInvoice(request: MakeInvoiceRequest): Promise<MakeInvoiceResult>;
  listTransactions(request: ListTransactionsRequest): Promise<ListTransactionsResult>;
  close?(): Promise<void> | void;
}

export function isTransactionSettled(result: NwcTransaction): boolean {
  return (
    (result.settled_at !== undefined && result.settled_at > 0) ||
    result.transaction_state === "settled" ||
    result.state === "settled"
  );
}

export function parseNwcUri(uri: string): ParsedNwcConnection {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new NwcUriParseError("invalid_uri", "Invalid NWC URI.", uri);
  }

  if (parsed.protocol !== NWC_URI_PROTOCOL) {
    throw new NwcUriParseError("invalid_scheme", "NWC URI must use nostr+walletconnect.", uri);
  }

  const walletPubkey = parsed.hostname || parsed.pathname.replace(/^\/+/, "");
  if (!walletPubkey) {
    throw new NwcUriParseError(
      "missing_wallet_pubkey",
      "NWC URI is missing the wallet public key.",
      uri,
    );
  }
  if (!HEX_64.test(walletPubkey)) {
    throw new NwcUriParseError(
      "invalid_wallet_pubkey",
      "NWC wallet public key must be 64 hex characters.",
      uri,
    );
  }

  const relays = parsed.searchParams.getAll("relay");
  if (relays.length === 0) {
    throw new NwcUriParseError("missing_relay", "NWC URI must include at least one relay.", uri);
  }
  for (const relay of relays) {
    if (!isValidRelayUrl(relay)) {
      throw new NwcUriParseError("invalid_relay", "NWC relay URLs must be valid wss URLs.", uri);
    }
  }

  const secrets = parsed.searchParams.getAll("secret");
  if (secrets.length === 0 || secrets[0] === "") {
    throw new NwcUriParseError("missing_secret", "NWC URI is missing the client secret.", uri);
  }
  if (secrets.length !== 1 || !HEX_64.test(secrets[0])) {
    throw new NwcUriParseError(
      "invalid_secret",
      "NWC client secret must be 64 hex characters.",
      uri,
    );
  }

  const lud16 = parsed.searchParams.get("lud16") || undefined;

  return {
    walletPubkey,
    relays,
    clientSecret: secrets[0],
    lud16,
    redacted: redactNwcUri(uri),
  };
}

export function redactNwcUri(uri: string): string {
  const queryStart = uri.indexOf("?");
  if (queryStart === -1) return uri;

  const fragmentStart = uri.indexOf("#", queryStart + 1);
  const queryEnd = fragmentStart === -1 ? uri.length : fragmentStart;
  const beforeQuery = uri.slice(0, queryStart + 1);
  const query = uri.slice(queryStart + 1, queryEnd);
  const afterQuery = uri.slice(queryEnd);

  return `${beforeQuery}${redactNwcQuery(query)}${afterQuery}`;
}

function redactNwcQuery(query: string): string {
  return query
    .split("&")
    .map((part) => {
      const separator = part.indexOf("=");
      const key = separator === -1 ? part : part.slice(0, separator);
      if (!isSecretQueryKey(key)) return part;
      return `${key}=${NWC_REDACTED_SECRET}`;
    })
    .join("&");
}

function isSecretQueryKey(key: string): boolean {
  return decodeQueryComponent(key).toLowerCase() === "secret";
}

function decodeQueryComponent(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

function isValidRelayUrl(relay: string): boolean {
  if (!relay) return false;

  try {
    const parsed = new URL(relay);
    return parsed.protocol === "wss:" && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}
