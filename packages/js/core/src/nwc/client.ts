export const OPENRECEIVE_NWC_METADATA_MAX_BYTES = 3900 as const;

export type NwcEncryptionMode = "nip04" | "nip44_v2";

export type OpenReceiveTransactionState =
  | "pending"
  | "settled"
  | "expired"
  | "failed"
  | "accepted";

export type OpenReceiveWorkflowState =
  | "draft"
  | "invoice_created"
  | "verifying"
  | "awaiting_fulfillment"
  | "fulfilled"
  | "expiry_pending_verification"
  | "expired_closed"
  | "failed_closed"
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
  notifications: string[];
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

export interface LookupInvoiceRequest {
  payment_hash?: string;
  invoice?: string;
}

export interface LookupInvoiceResult {
  invoice?: string;
  payment_hash?: string;
  amount_msats?: bigint;
  transaction_state?: OpenReceiveTransactionState;
  state?: OpenReceiveTransactionState;
  created_at?: number;
  expires_at?: number;
  settled_at?: number;
  preimage?: string;
}

export interface PaymentReceivedNotification {
  payment_hash: string;
  invoice?: string;
  amount_msats?: bigint;
  settled_at?: number;
  raw?: unknown;
}

export interface OpenReceiveReceiveNwcClient {
  preflight(): Promise<WalletCapabilitySummary>;
  makeInvoice(request: MakeInvoiceRequest): Promise<MakeInvoiceResult>;
  lookupInvoice(request: LookupInvoiceRequest): Promise<LookupInvoiceResult>;
  subscribeToPaymentReceived?(
    handler: (notification: PaymentReceivedNotification) => Promise<void> | void
  ): Promise<() => Promise<void> | void>;
}

export interface StandaloneNwcClient extends OpenReceiveReceiveNwcClient {
  payInvoice(request: { invoice: string; amount_msats?: bigint }): Promise<unknown>;
}

export function isLookupSettled(result: LookupInvoiceResult): boolean {
  return result.settled_at !== undefined || result.transaction_state === "settled" || result.state === "settled";
}
