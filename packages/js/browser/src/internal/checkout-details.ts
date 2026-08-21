// The transaction-details rows and the payment-data entries — the two
// key/value panels the checkout renders under the invoice. Both are pure
// projections of a checkout state or display data into labelled rows.

import type {
  CheckoutInvoiceSnapshot,
  CheckoutInvoiceSwapSnapshot,
  CheckoutState,
  OpenReceiveTransactionDetailRow,
  OpenReceiveTransactionDetailsInput,
} from "./ui.ts";
import {
  formatOpenReceiveDepositAmount,
  formatOpenReceiveFiatAmount,
  formatOpenReceiveInvoiceLabel,
  formatOpenReceiveMsats,
  formatOpenReceivePaymentHashLabel,
  formatOpenReceiveUnixTime,
} from "./checkout-format.ts";
import { createOpenReceiveDetailExternalLink } from "./checkout-links.ts";
import {
  createOpenReceiveSwapFeeBreakdown,
  getOpenReceiveSwapAssetDisplay,
} from "./checkout-swap-view.ts";

/**
 * Build display rows for settled checkout / swap state from public OpenReceive
 * fields only. Omits undefined values; never surfaces NWC or send-payment secrets.
 */
export function createOpenReceiveTransactionDetails(
  input: OpenReceiveTransactionDetailsInput,
): OpenReceiveTransactionDetailRow[] {
  const rows: OpenReceiveTransactionDetailRow[] = [];
  const payInAsset = input.swap?.pay_in_asset;
  const push = (label: string, value: string | undefined, copyValue?: string) => {
    if (value === undefined || value === "") return;
    const linkValue = copyValue ?? value;
    const link = createOpenReceiveDetailExternalLink({
      label,
      value: linkValue,
      ...(payInAsset === undefined ? {} : { payInAsset }),
      ...(input.decodeLinkUrl === undefined ? {} : { decodeLinkUrl: input.decodeLinkUrl }),
    });
    rows.push({
      label,
      value,
      ...(copyValue === undefined ? {} : { copyValue }),
      ...(link === undefined ? {} : { href: link.href, hrefLabel: link.hrefLabel }),
    });
  };

  push("Order ID", input.order_id);
  push("Checkout ID", input.checkout_id);
  push("Invoice ID", input.invoice_id);
  push("Rail", input.rail);
  push("Status", input.transaction_state);
  push("Workflow", input.workflow_state);

  if (input.amount_msats !== undefined) {
    push("Amount", formatOpenReceiveMsats(input.amount_msats));
    push("Amount (msats)", String(input.amount_msats));
  }
  const fiat = formatOpenReceiveFiatAmount(input.fiat_quote?.fiat);
  push("Fiat", fiat);

  if (typeof input.invoice === "string" && input.invoice.length > 0) {
    push("Lightning invoice", formatOpenReceiveInvoiceLabel(input.invoice), input.invoice);
  }
  if (input.payment_hash !== undefined) {
    push("Payment hash", formatOpenReceivePaymentHashLabel(input.payment_hash), input.payment_hash);
  }

  if (input.settled_at !== undefined) {
    push("Settled at", formatOpenReceiveUnixTime(input.settled_at));
  }
  if (input.expires_at !== undefined) {
    push("Expires at", formatOpenReceiveUnixTime(input.expires_at));
  }

  const swap = input.swap;
  if (swap !== undefined) {
    // Once the order settles, swap polling stops (see CheckoutController.syncWatchers),
    // so `provider_state` is the last snapshot taken before settlement — it can lag
    // (e.g. still "awaiting_deposit" when the provider raced through deposit → payout
    // inside one poll interval). Label it as a last-known value, not a live one.
    // See docs/guides/automated-swaps.md, "Provider state after settlement".
    const settled = input.transaction_state === "settled" || input.settled_at !== undefined;
    const asset = getOpenReceiveSwapAssetDisplay(swap.pay_in_asset);
    push("Swap provider", swap.provider);
    push("Provider order", swap.provider_order_id);
    push("Swap attempt", swap.attempt_id);
    push("Pay-in asset", swap.pay_in_asset);
    push("Asset", asset.assetLabel);
    push("Network", asset.networkLabel);
    push("Deposit address", swap.deposit_address);
    push("Deposit memo", swap.deposit_memo);
    push("Deposit amount", formatOpenReceiveDepositAmount(swap.deposit_amount));
    if (swap.deposit_received_amount !== undefined) {
      push("Amount received", formatOpenReceiveDepositAmount(swap.deposit_received_amount));
    }
    push(settled ? "Last provider state" : "Provider state", swap.provider_state);
    if (swap.refund_reason !== undefined) {
      push("Refund reason", swap.refund_reason);
    }
    if (swap.refund_amount !== undefined) {
      push("Estimated refund", formatOpenReceiveDepositAmount(swap.refund_amount));
    }
    if (swap.provider_expires_at !== undefined) {
      push("Provider expires at", formatOpenReceiveUnixTime(swap.provider_expires_at));
    }
    push("Deposit transaction", swap.deposit_tx_id);
    push("Lightning payout", swap.payout_tx_id);
    push("Refund address", swap.refund_address);
    push("Refund transaction", swap.refund_tx_id);
    const feeBreakdown = createOpenReceiveSwapFeeBreakdown(swap.fee);
    if (feeBreakdown !== undefined) {
      push("Cart total", feeBreakdown.cartTotal);
      push("You send", feeBreakdown.youSend);
      push(
        "Swap + network fees",
        feeBreakdown.feePercent === undefined
          ? feeBreakdown.fee
          : `${feeBreakdown.fee} (${feeBreakdown.feePercent})`,
      );
    } else if (swap.fee !== undefined) {
      push("Fee currency", swap.fee.currency);
      push("Pay-in fiat", swap.fee.pay_in_fiat);
      push("Payout fiat", swap.fee.payout_fiat);
    }
  }

  return rows;
}

export function createOpenReceiveTransactionDetailsFromState(
  state: Pick<
    CheckoutState,
    | "order_id"
    | "checkout_id"
    | "invoice_id"
    | "invoice"
    | "rail"
    | "payment_hash"
    | "amount_msats"
    | "fiat_quote"
    | "transaction_state"
    | "workflow_state"
    | "expires_at"
    | "settled_at"
    | "swap"
  >,
): OpenReceiveTransactionDetailRow[] {
  return createOpenReceiveTransactionDetails({
    order_id: state.order_id,
    checkout_id: state.checkout_id,
    invoice_id: state.invoice_id,
    invoice: state.invoice,
    rail: state.rail,
    ...(state.payment_hash === undefined ? {} : { payment_hash: state.payment_hash }),
    ...(state.amount_msats === undefined ? {} : { amount_msats: state.amount_msats }),
    ...(state.fiat_quote === undefined ? {} : { fiat_quote: state.fiat_quote }),
    transaction_state: state.transaction_state,
    workflow_state: state.workflow_state,
    ...(state.expires_at === undefined ? {} : { expires_at: state.expires_at }),
    ...(state.settled_at === undefined ? {} : { settled_at: state.settled_at }),
    ...(state.swap === undefined ? {} : { swap: state.swap }),
  });
}

export interface OpenReceivePaymentDataEntry {
  readonly label: string;
  readonly value: string;
}

/** Structural subset of {@link CheckoutState} / display data a payment-data panel needs. */
export interface OpenReceivePaymentDataSource {
  readonly order_id?: string;
  readonly checkout_id?: string;
  readonly invoice_id?: string;
  readonly invoice?: string;
  readonly rail?: "lightning" | "swap" | "checkout_lock";
  readonly payment_hash?: string;
  readonly amount_msats?: number;
  readonly fiat_quote?: CheckoutInvoiceSnapshot["fiat_quote"];
  readonly transaction_state?: string;
  readonly workflow_state?: string;
  readonly settled_at?: number;
  readonly expires_at?: number;
  readonly swap?: CheckoutInvoiceSwapSnapshot;
}

/**
 * Everything the client knows about a payment, as ordered label/value rows for the
 * post-settlement "payment data" panel. Undefined fields are skipped.
 */
export function createOpenReceivePaymentDataEntries(
  source: OpenReceivePaymentDataSource,
): readonly OpenReceivePaymentDataEntry[] {
  const entries: OpenReceivePaymentDataEntry[] = [];
  const add = (label: string, value: string | undefined): void => {
    if (value !== undefined && value !== "") entries.push({ label, value });
  };
  const isoDate = (unixSeconds: number): string => new Date(unixSeconds * 1000).toISOString();
  add("Order", source.order_id);
  add("Checkout", source.checkout_id);
  add("Invoice ID", source.invoice_id);
  add("Payment hash", source.payment_hash);
  if (source.amount_msats !== undefined) {
    add("Amount", `${formatOpenReceiveMsats(source.amount_msats)} (${source.amount_msats} msats)`);
  }
  const fiat = source.fiat_quote?.fiat;
  if (fiat?.value !== undefined) {
    add("Fiat amount", fiat.currency === undefined ? fiat.value : `${fiat.value} ${fiat.currency}`);
  }
  add("Rail", source.rail);
  add("Transaction state", source.transaction_state);
  add("Workflow state", source.workflow_state);
  if (source.settled_at !== undefined) add("Settled at", isoDate(source.settled_at));
  if (source.expires_at !== undefined) add("Invoice expires at", isoDate(source.expires_at));
  if (source.swap !== undefined) {
    add("Swap provider", source.swap.provider);
    add("Swap pay-in asset", source.swap.pay_in_asset);
    add("Swap provider order", source.swap.provider_order_id);
    add("Swap state", source.swap.provider_state);
    add("Swap deposit tx", source.swap.deposit_tx_id);
    add("Swap payout tx", source.swap.payout_tx_id);
  }
  add("BOLT11 invoice", source.invoice);
  return entries;
}
