// The swap attempt as the payer sees it: the fee breakdown, the deposit-panel
// display model, the refund staging overlay, provider-state labels and
// details, and the asset/route matching the wizard selection needs.

import { formatDecimal, unixSeconds } from "@openreceive/core";
import {
  type CheckoutInvoiceSnapshot,
  type CheckoutInvoiceSwapFee,
  OPENRECEIVE_REFUND_REVIEW_NONCE,
  openReceiveCheckoutLabels,
  type OpenReceiveSwapDisplayModel,
  type OpenReceiveSwapFeeBreakdown,
} from "./ui.ts";
import {
  formatOpenReceiveCountdown,
  formatOpenReceiveDepositAmount,
  formatOpenReceiveFiatAmount,
  optionalDecimal,
  rescaleHalfUp,
  roundedDiv,
} from "./checkout-format.ts";

/**
 * Turn the provider's fiat equivalents into a display-ready fee breakout. The payer
 * sends crypto worth `pay_in_fiat`; the merchant receives `payout_fiat` (the cart
 * total). The difference is the swap fee (exchange spread + network fees). Returns
 * undefined when the figures are missing or not sensible so callers can hide the row.
 */
export function createOpenReceiveSwapFeeBreakdown(
  fee: CheckoutInvoiceSwapFee | undefined,
): OpenReceiveSwapFeeBreakdown | undefined {
  if (fee === undefined) return undefined;
  // Exact decimal math on the shared money engine — never binary floats, even
  // for display-only fiat values.
  const payIn = optionalDecimal(fee.pay_in_fiat);
  const payout = optionalDecimal(fee.payout_fiat);
  if (payIn === undefined || payout === undefined || payout.units <= 0n) return undefined;
  // Align to one scale, subtract exactly.
  const scale = Math.max(payIn.scale, payout.scale);
  const payInUnits = payIn.units * 10n ** BigInt(scale - payIn.scale);
  const payoutUnits = payout.units * 10n ** BigInt(scale - payout.scale);
  const feeUnits = payInUnits > payoutUnits ? payInUnits - payoutUnits : 0n;
  const format = (units: bigint): string => {
    const value = formatDecimal(rescaleHalfUp(units, scale, 2), 2);
    return (
      formatOpenReceiveFiatAmount({ currency: fee.currency, value }) ?? `${value} ${fee.currency}`
    );
  };
  // fee/payout * 100 at one decimal place, half-up: tenths = fee*1000/payout.
  const percentTenths = roundedDiv(feeUnits * 1000n, payoutUnits);
  const feePercent = `${(percentTenths / 10n).toString()}.${(percentTenths % 10n).toString()}%`;
  return {
    cartTotal: format(payoutUnits),
    youSend: format(payInUnits),
    fee: format(feeUnits),
    feePercent,
  };
}

export function createOpenReceiveSwapDisplayModel(
  invoice: CheckoutInvoiceSnapshot,
  options: { readonly now?: number } = {},
): OpenReceiveSwapDisplayModel | undefined {
  const swap = invoice.swap;
  if (swap === undefined) return undefined;
  const expiresAt = Math.min(
    swap.provider_expires_at,
    invoice.expires_at ?? swap.provider_expires_at,
  );
  const expiresInSeconds = Math.max(0, expiresAt - (options.now ?? unixSeconds()));
  const asset = getOpenReceiveSwapAssetDisplay(swap.pay_in_asset);
  const depositAmount = formatOpenReceiveDepositAmount(swap.deposit_amount);
  const networkWarningEmphasis = `${depositAmount} ${asset.assetLabel} on the ${asset.networkLabel} network`;
  // Settlement authority is OpenReceive's own wallet sweep, surfaced as the shadow
  // invoice's settled transaction_state — never the provider's `completed` state (see
  // OPENRECEIVE_SWAP_STATES). Once the order is paid the panel shows a final
  // confirmation, even if `provider_state` still lags on "confirming"/"exchanging".
  const settled = invoice.transaction_state === "settled" || invoice.settled_at !== undefined;
  const feeBreakdown = createOpenReceiveSwapFeeBreakdown(swap.fee);

  return {
    provider: swap.provider,
    attemptId: swap.attempt_id ?? invoice.invoice_id,
    payInAsset: swap.pay_in_asset,
    assetLabel: asset.assetLabel,
    networkLabel: asset.networkLabel,
    networkWarningTitle: openReceiveCheckoutLabels.wrongCurrencyOrNetworkTitle,
    networkWarningEmphasis,
    networkWarning: `Be sure you are sending exactly ${networkWarningEmphasis}. If you send the wrong currency or send on the wrong network, your funds will be lost! Pay with one method only — if you already sent ${asset.assetLabel}, do not also pay the Lightning invoice.`,
    depositAddress: swap.deposit_address,
    ...(swap.deposit_memo === undefined ? {} : { depositMemo: swap.deposit_memo }),
    depositAmount,
    providerStateLabel: settled
      ? "Payment complete"
      : getOpenReceiveSwapProviderStateLabel(swap.provider_state),
    providerStateDetail: settled
      ? "Your payment is confirmed and your order is complete."
      : getOpenReceiveSwapProviderStateDetail(swap.provider_state, swap.pay_in_asset, {
          refundReason: swap.refund_reason,
          depositAmount: swap.deposit_amount,
          depositReceivedAmount: swap.deposit_received_amount,
          refundAmount: swap.refund_amount,
        }),
    state: settled ? "settled" : getOpenReceiveSwapPanelState(swap.provider_state),
    expiresInSeconds,
    countdownLabel: formatOpenReceiveCountdown(expiresInSeconds),
    qrPayload: createOpenReceiveSwapQrPayload(swap),
    ...(feeBreakdown === undefined ? {} : { feeBreakdown }),
    ...(swap.deposit_tx_id === undefined ? {} : { depositTxId: swap.deposit_tx_id }),
    ...(swap.payout_tx_id === undefined ? {} : { payoutTxId: swap.payout_tx_id }),
    ...(swap.refund_address === undefined ? {} : { refundAddress: swap.refund_address }),
    ...(swap.refund_nonce !== undefined
      ? { refundNonce: swap.refund_nonce }
      : swap.provider_state === "refund_required"
        ? { refundNonce: OPENRECEIVE_REFUND_REVIEW_NONCE }
        : {}),
    ...(swap.refund_tx_id === undefined ? {} : { refundTxId: swap.refund_tx_id }),
    ...(swap.refund_reason === undefined ? {} : { refundReason: swap.refund_reason }),
    ...(swap.deposit_received_amount === undefined
      ? {}
      : {
          depositReceivedAmount: formatOpenReceiveDepositAmount(swap.deposit_received_amount),
        }),
    ...(swap.refund_amount === undefined
      ? {}
      : { refundAmount: formatOpenReceiveDepositAmount(swap.refund_amount) }),
    ...(swap.provider_order_id === undefined ? {} : { providerOrderId: swap.provider_order_id }),
  };
}

/**
 * Poll snapshots omit the locally staged refund address/nonce. Overlay them so
 * Review → Confirm is not wiped by the next `/swaps/status` tick.
 */
export function overlayOpenReceiveSwapRefundStaging(
  invoice: CheckoutInvoiceSnapshot,
  local: CheckoutInvoiceSnapshot | undefined | null,
): CheckoutInvoiceSnapshot {
  const localSwap = local?.swap;
  const invoiceSwap = invoice.swap;
  if (
    local === undefined ||
    local === null ||
    localSwap === undefined ||
    invoiceSwap === undefined
  ) {
    return invoice;
  }
  if (local.invoice_id !== invoice.invoice_id) return invoice;
  const refund_address = invoiceSwap.refund_address ?? localSwap.refund_address;
  const refund_nonce = invoiceSwap.refund_nonce ?? localSwap.refund_nonce;
  if (refund_address === invoiceSwap.refund_address && refund_nonce === invoiceSwap.refund_nonce) {
    return invoice;
  }
  return {
    ...invoice,
    swap: {
      ...invoiceSwap,
      ...(refund_address === undefined ? {} : { refund_address }),
      ...(refund_nonce === undefined ? {} : { refund_nonce }),
    },
  };
}

export function openReceiveSwapAssetMatchesRoute(
  routeKey: string,
  payInAsset: string | undefined,
): boolean {
  if (payInAsset === undefined) return false;
  const route = routeKey.includes(":") ? (routeKey.split(":").at(-1) ?? routeKey) : routeKey;
  if (route === "usdt") return payInAsset.startsWith("USDT_");
  if (route === "usdc") return payInAsset.startsWith("USDC_");
  if (route === "eth") return payInAsset === "ETH_ETH";
  if (route === "sol") return payInAsset === "SOL_SOL";
  return false;
}

export function getOpenReceiveSwapProviderStateLabel(state: string): string {
  if (state === "creating_provider_order") return "Preparing payment address";
  if (state === "awaiting_deposit") return "Waiting for your payment";
  if (state === "confirming") return "Confirming payment";
  if (state === "exchanging") return "Converting payment";
  if (state === "paying_invoice" || state === "completed") return "Finalizing checkout";
  if (state === "expired") return "Expired";
  if (state === "refund_required") return "Refund needed";
  if (state === "refund_pending") return "Refund pending";
  if (state === "refunded") return "Refunded";
  if (state === "attention") return "Needs attention";
  if (state === "failed") return "Failed";
  return state;
}

function getOpenReceiveSwapProviderStateDetail(
  state: string,
  payInAsset: string,
  refundContext: {
    readonly refundReason?: string;
    readonly depositAmount?: string;
    readonly depositReceivedAmount?: string;
    readonly refundAmount?: string;
  } = {},
): string {
  const { networkLabel, assetLabel } = getOpenReceiveSwapAssetDisplay(payInAsset);
  if (state === "creating_provider_order") return "Creating a payment address.";
  if (state === "awaiting_deposit") return "Send exactly the amount shown below.";
  if (state === "confirming") {
    return `Your payment was detected on ${networkLabel}. ${getOpenReceiveSwapConfirmationWaitHint(payInAsset)}`;
  }
  if (state === "exchanging") {
    return "Your payment is confirmed and being converted. This usually finishes within a minute.";
  }
  if (state === "paying_invoice" || state === "completed") {
    return "The provider is sending the Lightning payment. This usually takes a few seconds.";
  }
  if (state === "expired") return "No payment was received before the payment window closed.";
  if (state === "refund_required" || state === "refund_pending" || state === "refunded") {
    return getOpenReceiveSwapRefundDetail(state, assetLabel, refundContext);
  }
  if (state === "attention") return "This payment needs support review.";
  if (state === "failed") return "This payment address can no longer be used.";
  return state;
}

function getOpenReceiveSwapRefundDetail(
  state: string,
  assetLabel: string,
  refundContext: {
    readonly refundReason?: string;
    readonly depositAmount?: string;
    readonly depositReceivedAmount?: string;
    readonly refundAmount?: string;
  },
): string {
  const reasonDetail = getOpenReceiveSwapRefundReasonDetail(refundContext, assetLabel);
  const refundAmountDetail =
    refundContext.refundAmount === undefined
      ? undefined
      : `Estimated refund: ${formatOpenReceiveDepositAmount(refundContext.refundAmount)} ${assetLabel} before network fees.`;

  if (state === "refund_required") {
    const action = "Enter an address you control to request a refund.";
    return [reasonDetail, action, refundAmountDetail].filter(Boolean).join(" ");
  }
  if (state === "refund_pending") {
    return [reasonDetail, "Your refund request has been sent.", refundAmountDetail]
      .filter(Boolean)
      .join(" ");
  }
  return [reasonDetail, "The provider reports the refund was sent.", refundAmountDetail]
    .filter(Boolean)
    .join(" ");
}

function getOpenReceiveSwapRefundReasonDetail(
  refundContext: {
    readonly refundReason?: string;
    readonly depositAmount?: string;
    readonly depositReceivedAmount?: string;
  },
  assetLabel: string,
): string | undefined {
  const expected =
    refundContext.depositAmount === undefined
      ? undefined
      : formatOpenReceiveDepositAmount(refundContext.depositAmount);
  const received =
    refundContext.depositReceivedAmount === undefined
      ? undefined
      : formatOpenReceiveDepositAmount(refundContext.depositReceivedAmount);

  if (refundContext.refundReason === "underpaid") {
    if (expected !== undefined && received !== undefined) {
      return `You sent ${received} ${assetLabel} but ${expected} ${assetLabel} was required.`;
    }
    return "The amount received was less than required.";
  }
  if (refundContext.refundReason === "late_deposit") {
    return "Your payment arrived after the payment window closed.";
  }
  if (refundContext.refundReason === "underpaid_and_late") {
    if (expected !== undefined && received !== undefined) {
      return `You sent ${received} ${assetLabel} but ${expected} ${assetLabel} was required, and it arrived after the payment window closed.`;
    }
    return "Your payment was under the required amount and arrived after the window closed.";
  }
  return undefined;
}

/**
 * Rough payer-facing confirmation guidance by deposit network. Not a SLA —
 * chain congestion and provider policy can take longer.
 */
export function getOpenReceiveSwapConfirmationWaitHint(payInAsset: string): string {
  const network = payInAsset.includes("_")
    ? (payInAsset.split("_").at(-1) ?? payInAsset)
    : payInAsset;
  if (network === "TRON") return "Confirmation usually takes 1–3 minutes.";
  if (network === "SOL") return "Confirmation usually takes under a minute.";
  if (network === "ETH") return "Confirmation often takes 5–15 minutes.";
  return "Confirmation usually takes a few minutes.";
}

function getOpenReceiveSwapPanelState(state: string): OpenReceiveSwapDisplayModel["state"] {
  if (state === "creating_provider_order") return "creating";
  if (state === "awaiting_deposit") return "deposit";
  if (
    state === "confirming" ||
    state === "exchanging" ||
    state === "paying_invoice" ||
    state === "completed"
  ) {
    return "progress";
  }
  if (state === "expired") return "expired";
  if (state === "refund_required") return "refund_required";
  if (state === "refund_pending") return "refund_pending";
  if (state === "refunded") return "refunded";
  if (state === "attention") return "attention";
  return "failed";
}

export function getOpenReceiveSwapAssetDisplay(payInAsset: string): {
  readonly assetLabel: string;
  readonly networkLabel: string;
} {
  const [asset, network] = payInAsset.split("_");
  const networkLabel =
    network === "TRON"
      ? "Tron"
      : network === "SOL"
        ? "Solana"
        : network === "ETH"
          ? "Ethereum"
          : (network ?? payInAsset);
  return {
    assetLabel: asset ?? payInAsset,
    networkLabel,
  };
}

function createOpenReceiveSwapQrPayload(
  swap: NonNullable<CheckoutInvoiceSnapshot["swap"]>,
): string {
  if (swap.pay_in_asset === "ETH_ETH") {
    const wei = decimalAmountToIntegerString(swap.deposit_amount, 18);
    return wei === undefined
      ? swap.deposit_address
      : `ethereum:${swap.deposit_address}?value=${wei}`;
  }
  if (swap.pay_in_asset === "SOL_SOL") {
    const amount = formatOpenReceiveDepositAmount(swap.deposit_amount);
    return `solana:${swap.deposit_address}?amount=${encodeURIComponent(amount)}`;
  }
  return swap.deposit_address;
}

function decimalAmountToIntegerString(amount: string, decimals: number): string | undefined {
  const parsed = optionalDecimal(amount);
  if (parsed === undefined || parsed.scale > decimals) return undefined;
  return (parsed.units * 10n ** BigInt(decimals - parsed.scale)).toString();
}

/**
 * Provider states this attempt can never leave, mirroring the engine's swap
 * state table (`terminal: true` there). `refund_required`/`refund_pending` are
 * deliberately absent: the payer still acts on the first, and the second must
 * keep polling to observe the provider reaching `refunded`.
 */
export function isTerminalSwapProviderState(providerState: string | undefined): boolean {
  return (
    providerState === "expired" ||
    providerState === "refunded" ||
    providerState === "attention" ||
    providerState === "failed"
  );
}
