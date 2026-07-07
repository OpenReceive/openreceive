import type { OpenReceiveSwapPayInAsset } from "./assets.ts";

export type OpenReceiveSwapProviderState =
  | "creating_provider_order"
  | "awaiting_deposit"
  | "confirming"
  | "exchanging"
  | "paying_invoice"
  | "completed"
  | "expired"
  | "refund_required"
  | "refund_pending"
  | "refunded"
  | "attention"
  | "failed";

export type OpenReceiveSwapAvailabilityReason =
  | "provider_unconfigured"
  | "amount_too_small"
  | "amount_too_large"
  | "pair_temporarily_unavailable"
  | "region_unsupported"
  | "provider_rate_limited"
  | "provider_unreachable";

export interface OpenReceiveSwapQuote {
  readonly pay_amount?: string;
  readonly minimum_pay_amount?: string;
  readonly maximum_pay_amount?: string;
  readonly pay_asset: OpenReceiveSwapPayInAsset;
  readonly available: boolean;
  readonly unavailable_reason?: OpenReceiveSwapAvailabilityReason;
  readonly unavailable_message?: string;
  readonly provider: string;
}

export interface OpenReceiveSwapProviderAsset {
  readonly pay_asset: OpenReceiveSwapPayInAsset;
  readonly available?: boolean;
  readonly unavailable_reason?: OpenReceiveSwapAvailabilityReason;
  readonly unavailable_message?: string;
  readonly minimum_pay_amount?: string;
  readonly maximum_pay_amount?: string;
  readonly minimum_invoice_amount_msats?: number;
  readonly maximum_invoice_amount_msats?: number;
}

export interface OpenReceiveSwapOrder {
  readonly provider: string;
  readonly provider_order_id: string;
  readonly provider_token: string;
  readonly pay_in_asset: OpenReceiveSwapPayInAsset;
  readonly deposit_address: string;
  readonly deposit_memo?: string;
  readonly deposit_amount: string;
  readonly expires_at: number;
  readonly state: OpenReceiveSwapProviderState;
  readonly deposit_tx_id?: string;
  readonly payout_tx_id?: string;
  readonly refund_tx_id?: string;
  readonly attention?: boolean;
  readonly raw?: unknown;
}

export interface OpenReceiveSwapProvider {
  readonly name: string;
  supportedPayInAssets(): Promise<Set<OpenReceiveSwapPayInAsset>>;
  payInAssetCatalog?(): Promise<readonly OpenReceiveSwapProviderAsset[]>;
  invoiceExpirySeconds?(input: { readonly payInAsset: OpenReceiveSwapPayInAsset }): number;
  quote(input: {
    readonly payInAsset: OpenReceiveSwapPayInAsset;
    readonly invoiceAmountMsats: number;
  }): Promise<OpenReceiveSwapQuote>;
  createSwap(input: {
    readonly payInAsset: OpenReceiveSwapPayInAsset;
    readonly bolt11: string;
    readonly invoiceAmountMsats: number;
  }): Promise<OpenReceiveSwapOrder>;
  getStatus(order: OpenReceiveSwapOrder): Promise<OpenReceiveSwapOrder>;
  requestRefund(order: OpenReceiveSwapOrder, refundAddress: string): Promise<void>;
}

export function isOpenReceiveSwapTerminalState(state: string | undefined): boolean {
  return state === "expired" || state === "refunded" || state === "attention" || state === "failed";
}
