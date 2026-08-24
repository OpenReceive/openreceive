export const OPENRECEIVE_NWC_METADATA_MAX_BYTES = 3900 as const;
const NWC_URI_PROTOCOL = "nostr+walletconnect:" as const;
const NWC_REDACTED_SECRET = "[REDACTED]" as const;
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
    // The human-readable text is the message; the snake_case code stays a
    // machine-readable field (it is not wire-facing).
    super(description);
    this.name = "NwcUriParseError";
    this.code = code;
    this.description = description;
    this.redacted = uri === undefined ? undefined : redactNwcUri(uri);
  }
}

export function formatMissingNwcMessage(input: { readonly subject?: string } = {}): string {
  const subject = input.subject ?? "OpenReceive";
  return [
    `${subject} needs a receive-only NWC code to receive payments.`,
    "Set NWC_URI to your receive-only Nostr Wallet Connect connection string.",
    `Get one here: ${OPENRECEIVE_NWC_CODE_HELP_URL}`,
  ].join("\n");
}

/**
 * Host-facing message for a connection string that parsed as invalid.
 * `subject` names where the value came from so the operator knows what to fix;
 * it defaults to the environment variable every bundled entry point reads.
 */
export function formatInvalidNwcMessage(
  input: { readonly reason?: string; readonly subject?: string } = {},
): string {
  const subject = input.subject ?? "NWC_URI";
  return [
    `${subject} is set, but it is not a valid NWC code.`,
    input.reason === undefined ? undefined : `Reason: ${input.reason}`,
    `Get a receive-only NWC code here: ${OPENRECEIVE_NWC_CODE_HELP_URL}`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function normalizedSpendMethods(spendMethods: readonly string[] | undefined): string {
  const methods =
    spendMethods === undefined || spendMethods.length === 0 ? ["pay_invoice"] : [...spendMethods];
  return methods.join(", ");
}

/**
 * Boot refusal message when the NIP-47 info event advertises send-payment methods
 * such as `pay_invoice`. OpenReceive fails closed on spend-capable connections.
 */
export function formatSpendCapabilityRefusedMessage(
  input: { readonly spendMethods?: readonly string[] } = {},
): string {
  return [
    "This NWC connection is NOT receive-only.",
    `The wallet info event advertises spend method(s): ${normalizedSpendMethods(input.spendMethods)}.`,
    "A leaked spend-capable NWC code lets an attacker drain the wallet, so OpenReceive refuses to boot with it.",
    `Get a receive-only NWC code here: ${OPENRECEIVE_NWC_CODE_HELP_URL}`,
    "If this wallet cannot mint a receive-only code and you accept the risk, set allowSpendCapableWallet: true (or OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC=true).",
  ].join("\n");
}

/**
 * Loud console warning when the host explicitly overrides the spend-capability
 * refusal. OpenReceive boots after this message only because the override is set.
 */
export function formatSpendCapabilityWarningMessage(
  input: { readonly spendMethods?: readonly string[] } = {},
): string {
  return [
    "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
    "ERROR: This NWC connection is NOT receive-only.",
    `The wallet info event advertises spend method(s): ${normalizedSpendMethods(input.spendMethods)}.`,
    "OpenReceive must use a receive-only NWC code (no pay_invoice).",
    "Booting anyway because the spend-capable override is explicitly set.",
    `Get a receive-only NWC code here: ${OPENRECEIVE_NWC_CODE_HELP_URL}`,
    "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
  ].join("\n");
}

export type TransactionState = "pending" | "settled" | "expired" | "failed" | "accepted";

export interface ParsedNwcConnection {
  walletPubkey: string;
  relays: string[];
  clientSecret: string;
  lud16?: string;
  redacted: string;
}

/** Public, loggable view of a parsed NWC connection — everything but the secret. */
export interface RedactedNwcConnection {
  readonly walletPubkey: string;
  readonly relays: readonly string[];
  readonly lud16?: string;
  readonly redacted: string;
}

export interface WalletCapabilitySummary {
  walletPubkey: string;
  relays: string[];
  methods: string[];
  /** Undefined when the wallet advertises encryption modes and none is supported. */
  encryption: NwcEncryptionMode | undefined;
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

/**
 * One wallet transaction row, normalized at the client boundary.
 *
 * Field invariants the settlement rules rely on — a custom
 * {@link ReceiveNwcClient} must produce rows that honor them:
 * - `payment_hash` / `invoice` / `preimage`: non-empty when present; a wallet's
 *   empty string means "absent", not "empty value".
 * - `amount_msats` / `fees_paid_msats`: whole millisatoshis as `bigint`.
 * - `created_at` / `expires_at` / `settled_at`: whole non-negative Unix seconds.
 * - `transaction_state` / `state`: an {@link TransactionState}. The
 *   settlement classifiers compare case-insensitively, so a wallet spelling of
 *   `"SETTLED"` still settles, but the canonical value is lowercase.
 */
export interface NwcTransaction {
  type?: "incoming" | "outgoing";
  invoice?: string;
  payment_hash?: string;
  amount_msats?: bigint;
  transaction_state?: TransactionState;
  state?: TransactionState;
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
  /**
   * Rows on this page the client could not normalize, and therefore dropped.
   * A mixed page is tolerated so one quirky row cannot livelock reconciliation;
   * a page where EVERY row is unusable fails the scan instead, because an
   * empty-looking scan at expiry+grace closes pending attempts. Reported so a
   * caller can see the tolerance being exercised rather than infer it.
   */
  skippedRows?: number;
}

export interface ReceiveNwcClient {
  preflight(): Promise<WalletCapabilitySummary>;
  makeInvoice(request: MakeInvoiceRequest): Promise<MakeInvoiceResult>;
  listTransactions(request: ListTransactionsRequest): Promise<ListTransactionsResult>;
  close?(): Promise<void> | void;
}

/**
 * Case-insensitive comparison of a wallet-supplied state field. Normalizing
 * case here is not a wallet guard — the wallet is trusted; it is the same
 * spelling tolerance the adapter applies to `list_transactions` rows, so a
 * custom client handing back a raw `"SETTLED"` still settles its attempt.
 */
export function isTransactionState(
  value: TransactionState | undefined,
  expected: TransactionState,
): boolean {
  return typeof value === "string" && value.toLowerCase() === expected;
}

export function isTransactionSettled(result: NwcTransaction): boolean {
  return (
    (result.settled_at !== undefined && result.settled_at > 0) ||
    isTransactionState(result.transaction_state, "settled") ||
    isTransactionState(result.state, "settled")
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
