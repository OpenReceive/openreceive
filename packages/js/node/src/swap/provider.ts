import type { OpenReceiveSwapPayInAsset } from "./assets.ts";

export type OpenReceiveSwapProviderState =
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

export interface OpenReceiveSwapQuote {
  readonly pay_amount?: string;
  readonly pay_asset: OpenReceiveSwapPayInAsset;
  readonly min_ok: boolean;
  readonly max_ok: boolean;
  readonly provider: string;
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
  return (
    state === "completed" ||
    state === "expired" ||
    state === "refunded" ||
    state === "attention" ||
    state === "failed"
  );
}
