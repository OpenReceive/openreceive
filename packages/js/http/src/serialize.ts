// Serialize camelCase `@openreceive/node` service objects to OpenAPI snake_case wire JSON.

import type {
  Checkout,
  Invoice,
  Order,
  OrderStatus,
  PublicSwap,
  SwapAttempt,
  SwapOption,
} from "@openreceive/node";

/** OpenAPI snake_case swap-option body. */
export interface HttpSwapOption {
  readonly pay_in_asset: SwapOption["payInAsset"];
  readonly label: string;
  readonly network_label: string;
  readonly provider: string;
  readonly available: boolean;
  readonly unavailable_reason?: SwapOption["unavailableReason"];
  readonly unavailable_message?: string;
  readonly pay_amount?: string;
  readonly minimum_pay_amount?: string;
  readonly maximum_pay_amount?: string;
  readonly minimum_invoice_amount_msats?: number;
  readonly maximum_invoice_amount_msats?: number;
}

/** OpenAPI snake_case public-swap body. */
export interface HttpPublicSwap {
  readonly attempt_id: string;
  readonly provider: string;
  readonly provider_order_id?: string;
  readonly pay_in_asset: PublicSwap["payInAsset"];
  readonly deposit_address: string;
  readonly deposit_memo?: string;
  readonly deposit_amount: string;
  readonly provider_state: PublicSwap["providerState"];
  readonly provider_expires_at: number;
  readonly deposit_tx_id?: string;
  readonly payout_tx_id?: string;
  readonly refund_address?: string;
  readonly refund_nonce?: string;
  readonly refund_nonce_expires_at?: number;
  readonly refund_tx_id?: string;
  readonly attention?: boolean;
  readonly attention_reason?: PublicSwap["attentionReason"];
  readonly emergency_repeat?: boolean;
  readonly fee?: PublicSwap["fee"];
}

/** OpenAPI snake_case invoice body. */
export interface HttpInvoice {
  readonly invoice_id: string;
  readonly type: "incoming";
  readonly rail: "lightning" | "swap";
  readonly status: Invoice["status"];
  readonly transaction_state: string;
  readonly workflow_state: string;
  readonly invoice: string | null;
  readonly payment_hash: string;
  readonly amount_msats: number;
  readonly order_id: string;
  readonly created_at: number;
  readonly expires_at: number;
  readonly settled_at?: number;
  readonly settlement_action_completed_at?: number;
  readonly refreshed_from_invoice_id?: string;
  readonly fiat_quote: Invoice["fiatQuote"];
  readonly settlement_action_state: string;
  readonly swap?: HttpPublicSwap;
}

/** OpenAPI snake_case checkout body. */
export interface HttpCheckout {
  readonly checkout_id: string;
  readonly order_id: string;
  readonly status: Checkout["status"];
  readonly amount_msats: number;
  readonly fiat?: Checkout["fiat"];
  readonly active?: HttpInvoice;
  readonly invoices: readonly HttpInvoice[];
  readonly paid_at?: number;
  readonly created_at: number;
}

/** OpenAPI snake_case order body. */
export interface HttpOrder {
  readonly order_id: string;
  readonly status: Order["status"];
  readonly paid: boolean;
  readonly paid_at?: number;
  readonly display_checkout?: HttpCheckout;
  readonly paid_checkout?: HttpCheckout;
  readonly active_checkout?: HttpCheckout;
  readonly checkouts: readonly HttpCheckout[];
  readonly wallet_scan_performed: boolean;
  readonly transactions_checked: number;
}

/** OpenAPI snake_case order-status body (default `order` action). */
export interface HttpOrderStatus extends HttpOrder {
  readonly swaps_enabled: boolean;
  readonly swap_pay_options: readonly HttpSwapOption[];
}

/** OpenAPI snake_case swap-attempt body. */
export interface HttpSwapAttempt extends HttpPublicSwap {
  readonly order_id: string;
  readonly shadow_invoice: HttpInvoice;
}

export function toHttpSwapOption(option: SwapOption): HttpSwapOption {
  return {
    pay_in_asset: option.payInAsset,
    label: option.label,
    network_label: option.networkLabel,
    provider: option.provider,
    available: option.available,
    ...(option.unavailableReason === undefined
      ? {}
      : { unavailable_reason: option.unavailableReason }),
    ...(option.unavailableMessage === undefined
      ? {}
      : { unavailable_message: option.unavailableMessage }),
    ...(option.payAmount === undefined ? {} : { pay_amount: option.payAmount }),
    ...(option.minimumPayAmount === undefined
      ? {}
      : { minimum_pay_amount: option.minimumPayAmount }),
    ...(option.maximumPayAmount === undefined
      ? {}
      : { maximum_pay_amount: option.maximumPayAmount }),
    ...(option.minimumInvoiceAmountMsats === undefined
      ? {}
      : { minimum_invoice_amount_msats: option.minimumInvoiceAmountMsats }),
    ...(option.maximumInvoiceAmountMsats === undefined
      ? {}
      : { maximum_invoice_amount_msats: option.maximumInvoiceAmountMsats }),
  };
}

export function toHttpPublicSwap(swap: PublicSwap): HttpPublicSwap {
  return {
    attempt_id: swap.attemptId,
    provider: swap.provider,
    ...(swap.providerOrderId === undefined
      ? {}
      : { provider_order_id: swap.providerOrderId }),
    pay_in_asset: swap.payInAsset,
    deposit_address: swap.depositAddress,
    ...(swap.depositMemo === undefined ? {} : { deposit_memo: swap.depositMemo }),
    deposit_amount: swap.depositAmount,
    provider_state: swap.providerState,
    provider_expires_at: swap.providerExpiresAt,
    ...(swap.depositTxId === undefined ? {} : { deposit_tx_id: swap.depositTxId }),
    ...(swap.payoutTxId === undefined ? {} : { payout_tx_id: swap.payoutTxId }),
    ...(swap.refundAddress === undefined ? {} : { refund_address: swap.refundAddress }),
    ...(swap.refundNonce === undefined ? {} : { refund_nonce: swap.refundNonce }),
    ...(swap.refundNonceExpiresAt === undefined
      ? {}
      : { refund_nonce_expires_at: swap.refundNonceExpiresAt }),
    ...(swap.refundTxId === undefined ? {} : { refund_tx_id: swap.refundTxId }),
    ...(swap.attention === undefined ? {} : { attention: swap.attention }),
    ...(swap.attentionReason === undefined
      ? {}
      : { attention_reason: swap.attentionReason }),
    ...(swap.emergencyRepeat === undefined
      ? {}
      : { emergency_repeat: swap.emergencyRepeat }),
    ...(swap.fee === undefined ? {} : { fee: swap.fee }),
  };
}

export function toHttpInvoice(invoice: Invoice): HttpInvoice {
  return {
    invoice_id: invoice.invoiceId,
    type: invoice.type,
    rail: invoice.rail,
    status: invoice.status,
    transaction_state: invoice.transactionState,
    workflow_state: invoice.workflowState,
    invoice: invoice.rail === "swap" ? null : invoice.bolt11,
    payment_hash: invoice.paymentHash,
    amount_msats: invoice.amountMsats,
    order_id: invoice.orderId,
    created_at: invoice.createdAt,
    expires_at: invoice.expiresAt,
    ...(invoice.settledAt === undefined ? {} : { settled_at: invoice.settledAt }),
    ...(invoice.settlementActionCompletedAt === undefined
      ? {}
      : { settlement_action_completed_at: invoice.settlementActionCompletedAt }),
    ...(invoice.refreshedFromInvoiceId === undefined
      ? {}
      : { refreshed_from_invoice_id: invoice.refreshedFromInvoiceId }),
    fiat_quote: invoice.fiatQuote,
    settlement_action_state: invoice.settlementActionState,
    ...(invoice.swap === undefined ? {} : { swap: toHttpPublicSwap(invoice.swap) }),
  };
}

export function toHttpCheckout(checkout: Checkout): HttpCheckout {
  return {
    checkout_id: checkout.checkoutId,
    order_id: checkout.orderId,
    status: checkout.status,
    amount_msats: checkout.amountMsats,
    ...(checkout.fiat === undefined ? {} : { fiat: checkout.fiat }),
    ...(checkout.active === undefined ? {} : { active: toHttpInvoice(checkout.active) }),
    invoices: checkout.invoices.map(toHttpInvoice),
    ...(checkout.paidAt === undefined ? {} : { paid_at: checkout.paidAt }),
    created_at: checkout.createdAt,
  };
}

export function toHttpOrder(order: Order): HttpOrder {
  return {
    order_id: order.orderId,
    status: order.status,
    paid: order.paid,
    ...(order.paidAt === undefined ? {} : { paid_at: order.paidAt }),
    ...(order.displayCheckout === undefined
      ? {}
      : { display_checkout: toHttpCheckout(order.displayCheckout) }),
    ...(order.paidCheckout === undefined
      ? {}
      : { paid_checkout: toHttpCheckout(order.paidCheckout) }),
    ...(order.activeCheckout === undefined
      ? {}
      : { active_checkout: toHttpCheckout(order.activeCheckout) }),
    checkouts: order.checkouts.map(toHttpCheckout),
    wallet_scan_performed: order.walletScanPerformed,
    transactions_checked: order.transactionsChecked,
  };
}

export function toHttpOrderStatus(status: OrderStatus): HttpOrderStatus {
  return {
    ...toHttpOrder(status),
    swaps_enabled: status.swapsEnabled,
    swap_pay_options: status.swapPayOptions.map(toHttpSwapOption),
  };
}

export function toHttpSwapAttempt(attempt: SwapAttempt): HttpSwapAttempt {
  const { orderId, shadowInvoice, ...swap } = attempt;
  return {
    ...toHttpPublicSwap(swap),
    order_id: orderId,
    shadow_invoice: toHttpInvoice(shadowInvoice),
  };
}
