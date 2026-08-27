// The transaction-details rows: the key/value panel the checkout renders under
// the invoice, on the live screen and again on the receipt. A pure projection
// of a checkout state or display data into labelled rows.

import type { CheckoutState, TransactionDetailRow, TransactionDetailsInput } from "./ui.ts";
import {
  formatDepositAmount,
  formatFiatAmount,
  formatInvoiceLabel,
  formatMsats,
  formatPaymentHashLabel,
  formatUnixTime,
} from "./checkout-format.ts";
import { createDetailExternalLink, type DetailLinkKind } from "./checkout-links.ts";
import { createSwapFeeBreakdown, getSwapAssetDisplay } from "./checkout-swap-view.ts";

/**
 * Build display rows for settled checkout / swap state from public OpenReceive
 * fields only. Omits undefined values; never surfaces NWC or send-payment secrets.
 *
 * A `checkout_lock` rail returns NO rows. That rail is the deferred placeholder
 * a prepared checkout carries before the payer has chosen anything, so there is
 * no transaction to describe yet — and a host following "transaction details on
 * the live checkout AND on the receipt" would otherwise open a caret over a
 * record of nothing. An empty array is already every caller's "render nothing"
 * signal, so the rule enforces itself and no host has to learn the rail
 * vocabulary to obey it.
 */
export function createTransactionDetails(input: TransactionDetailsInput): TransactionDetailRow[] {
  if (input.rail === "checkout_lock") return [];
  const rows: TransactionDetailRow[] = [];
  const payInAsset = input.swap?.pay_in_asset;
  // `kind` says what the value IS; the label is only shown. A row with no kind
  // carries no external link.
  const push = (
    label: string,
    value: string | undefined,
    copyValue?: string,
    kind?: DetailLinkKind,
  ) => {
    if (value === undefined || value === "") return;
    const linkValue = copyValue ?? value;
    const link =
      kind === undefined
        ? undefined
        : createDetailExternalLink({
            kind,
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

  push("Order ID", input.reference);
  push("Checkout ID", input.checkout_id);
  push("Invoice ID", input.invoice_id);
  push("Rail", input.rail);
  push("Status", input.transaction_state);
  push("Workflow", input.workflow_state);

  if (input.amount_msats !== undefined) {
    push("Amount", formatMsats(input.amount_msats));
    push("Amount (msats)", String(input.amount_msats));
  }
  const fiat = formatFiatAmount(input.fiat_quote?.fiat);
  push("Fiat", fiat);

  if (typeof input.invoice === "string" && input.invoice.length > 0) {
    push("Lightning invoice", formatInvoiceLabel(input.invoice), input.invoice, "invoice");
  }
  if (input.payment_hash !== undefined) {
    push("Payment hash", formatPaymentHashLabel(input.payment_hash), input.payment_hash);
  }

  if (input.settled_at !== undefined) {
    push("Settled at", formatUnixTime(input.settled_at));
  }
  if (input.expires_at !== undefined) {
    push("Expires at", formatUnixTime(input.expires_at));
  }

  const swap = input.swap;
  if (swap !== undefined) {
    // Once the order settles, swap polling stops (see CheckoutController.syncWatchers),
    // so `provider_state` is the last snapshot taken before settlement — it can lag
    // (e.g. still "awaiting_deposit" when the provider raced through deposit → payout
    // inside one poll interval). Label it as a last-known value, not a live one.
    // See docs/guides/automated-swaps.md, "Provider state after settlement".
    const settled = input.transaction_state === "settled";
    const asset = getSwapAssetDisplay(swap.pay_in_asset);
    push("Swap provider", swap.provider);
    push("Provider order", swap.provider_order_id);
    push("Swap attempt", swap.attempt_id);
    push("Pay-in asset", swap.pay_in_asset);
    push("Asset", asset.assetLabel);
    push("Network", asset.networkLabel);
    push("Deposit address", swap.deposit_address, undefined, "address");
    push("Deposit memo", swap.deposit_memo);
    push("Deposit amount", formatDepositAmount(swap.deposit_amount));
    if (swap.deposit_received_amount !== undefined) {
      push("Amount received", formatDepositAmount(swap.deposit_received_amount));
    }
    push(settled ? "Last provider state" : "Provider state", swap.provider_state);
    if (swap.refund_reason !== undefined) {
      push("Refund reason", swap.refund_reason);
    }
    if (swap.refund_amount !== undefined) {
      push("Estimated refund", formatDepositAmount(swap.refund_amount));
    }
    if (swap.provider_expires_at !== undefined) {
      push("Provider expires at", formatUnixTime(swap.provider_expires_at));
    }
    push("Deposit transaction", swap.deposit_tx_id, undefined, "tx");
    push("Lightning payout", swap.payout_tx_id);
    push("Refund address", swap.refund_address, undefined, "address");
    push("Refund transaction", swap.refund_tx_id, undefined, "tx");
    const feeBreakdown = createSwapFeeBreakdown(swap.fee);
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

export function createTransactionDetailsFromState(
  state: Pick<
    CheckoutState,
    | "reference"
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
): TransactionDetailRow[] {
  return createTransactionDetails({
    reference: state.reference,
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

/**
 * Everything a transaction-details panel accepts: a live checkout state, the
 * flat detail input, pre-built rows, or nothing.
 *
 * React's `<TransactionDetails>` and the elements HTML renderer used to declare
 * this union and its resolver separately, byte-identically. Only the RENDERING
 * legitimately differs between them (React.createElement vs an HTML string);
 * which rows a source yields is one rule and lives here.
 */
export type TransactionDetailsSource =
  | CheckoutState
  | TransactionDetailsInput
  | readonly TransactionDetailRow[]
  | null
  | undefined;

export function resolveTransactionDetailRows(
  source: TransactionDetailsSource,
): TransactionDetailRow[] {
  if (source === null || source === undefined) return [];
  if (Array.isArray(source)) return [...source];
  if (isCheckoutStateSource(source)) {
    return createTransactionDetailsFromState(source);
  }
  return createTransactionDetails(source as TransactionDetailsInput);
}

/**
 * Distinguishes a CheckoutState from a flat detail input structurally: only the
 * state carries `phase` next to the identity fields, and only it wants the
 * state-shaped reader above.
 */
function isCheckoutStateSource(value: object): value is CheckoutState {
  return (
    "checkout_id" in value &&
    "reference" in value &&
    "invoice_id" in value &&
    "invoice" in value &&
    "transaction_state" in value &&
    "phase" in value
  );
}
