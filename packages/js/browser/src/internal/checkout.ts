/// <reference path="../qrcode.d.ts" />

import { ceilDiv, formatDecimal, type OpenReceiveDecimal, parseDecimal } from "@openreceive/core";
import * as defaultQrEncoder from "qrcode";
import {
  type CheckoutController,
  type CheckoutControllerOptions,
  type CheckoutDisplayData,
  type CheckoutDisplayModel,
  type CheckoutInvoiceSnapshot,
  type CheckoutInvoiceSwapFee,
  type CheckoutInvoiceSwapSnapshot,
  type CheckoutPhase,
  type CheckoutSnapshot,
  type CheckoutState,
  type CheckoutStatusModel,
  type CheckoutStatusModelInput,
  type CheckoutStatusRefresh,
  type CheckoutWatcherOptions,
  type CopyInvoiceOptions,
  type CreateCheckoutStateOptions,
  type CreateOpenReceiveStatusFetcherOptions,
  OPENRECEIVE_COPY_FEEDBACK_MS,
  OPENRECEIVE_DEFAULT_POLL_INTERVAL_MS,
  OPENRECEIVE_DEFAULT_PREFIX,
  OPENRECEIVE_LIGHTNING_REUSE_BUFFER_SECONDS,
  OPENRECEIVE_QR_DARK_COLOR,
  OPENRECEIVE_QR_ERROR_CORRECTION,
  OPENRECEIVE_QR_LIGHT_COLOR,
  OPENRECEIVE_QR_QUIET_ZONE_MODULES,
  OPENRECEIVE_REFUND_REVIEW_NONCE,
  type OpenReceiveBrowserLogEntry,
  type OpenReceiveBrowserLoggerOption,
  type OpenReceiveBrowserLogLevel,
  type OpenReceiveCheckoutPaymentMethod,
  type OpenReceiveQrEncoder,
  type OpenReceiveQrOptions,
  type OpenReceiveSwapDisplayModel,
  type OpenReceiveSwapFeeBreakdown,
  type OpenReceiveTickingValueController,
  type OpenReceiveTickingValueOptions,
  type OpenReceiveTransactionDetailRow,
  type OpenReceiveTransactionDetailsInput,
  type OpenReceiveTransientFeedbackController,
  type OpenReceiveTransientFeedbackOptions,
  type OpenWalletOptions,
  openReceiveCheckoutLabels,
  type RequestCheckoutOptions,
} from "./ui.ts";
import { resolveOpenReceiveBrowserLogger } from "./console-logger.ts";
import { openReceiveRoutePrefix } from "./routes.ts";
import { getOpenReceivePaymentStatusText } from "./wizard.ts";

export function createOpenReceiveTransientFeedbackController<T>(
  options: OpenReceiveTransientFeedbackOptions<T>,
): OpenReceiveTransientFeedbackController<T> {
  const delayMs = options.delayMs ?? OPENRECEIVE_COPY_FEEDBACK_MS;
  const setTimeoutFn = options.setTimeout ?? globalThis.setTimeout;
  const clearTimeoutFn = options.clearTimeout ?? globalThis.clearTimeout;
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;

  const clear = (): void => {
    if (timeout === undefined) return;
    clearTimeoutFn(timeout);
    timeout = undefined;
  };

  return {
    show(value: T): void {
      clear();
      options.onValue(value);
      timeout = setTimeoutFn(() => {
        timeout = undefined;
        options.onValue(options.resetValue);
      }, delayMs);
    },
    clear,
  };
}

export function createOpenReceiveTickingValueController(
  options: OpenReceiveTickingValueOptions,
): OpenReceiveTickingValueController {
  const intervalMs = options.intervalMs ?? 1000;
  const now = options.now ?? currentUnixSeconds;
  const setIntervalFn = options.setInterval ?? globalThis.setInterval;
  const clearIntervalFn = options.clearInterval ?? globalThis.clearInterval;
  let timer: ReturnType<typeof globalThis.setInterval> | undefined;

  const refresh = (): void => {
    options.onValue(now());
  };

  const stop = (): void => {
    if (timer === undefined) return;
    clearIntervalFn(timer);
    timer = undefined;
  };

  return {
    start(): void {
      stop();
      if (options.active === false) return;
      refresh();
      timer = setIntervalFn(refresh, intervalMs);
    },
    stop,
    refresh,
  };
}

export function formatOpenReceiveCountdown(seconds: number): string {
  const safeSeconds = Math.max(0, Math.trunc(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainderSeconds = safeSeconds % 60;
  return `${minutes}:${remainderSeconds.toString().padStart(2, "0")}`;
}

/**
 * Trim insignificant trailing zeros from a decimal crypto amount for display,
 * e.g. "12.25900000" -> "12.259" and "5.000" -> "5". Only fractional digits are
 * stripped: integer amounts like "100" keep their zeros, and non-numeric input
 * is returned unchanged.
 */
export function formatOpenReceiveDepositAmount(amount: string): string {
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(amount) || !amount.includes(".")) return amount;
  return amount.replace(/0+$/, "").replace(/\.$/, "");
}

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

/**
 * Provider-supplied display decimals are untrusted strings: parse with the shared
 * money engine but return undefined instead of throwing so the caller can hide the
 * row rather than break the panel.
 */
function optionalDecimal(value: string): OpenReceiveDecimal | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return parseDecimal(value);
  } catch {
    return undefined;
  }
}

/** Integer division rounded half up. */
function roundedDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

/** Re-scale integer units from `scale` to `digits` decimal places, half-up. */
function rescaleHalfUp(units: bigint, scale: number, digits: number): bigint {
  return roundedDiv(units * 10n ** BigInt(digits), 10n ** BigInt(scale));
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
  const expiresInSeconds = Math.max(0, expiresAt - (options.now ?? currentUnixSeconds()));
  const asset = getOpenReceiveSwapAssetDisplay(swap.pay_in_asset);
  const depositAmount = formatOpenReceiveDepositAmount(swap.deposit_amount);
  const networkWarningEmphasis = `${depositAmount} ${asset.assetLabel} on the ${asset.networkLabel} network`;
  // Settlement authority is OpenReceive's own wallet sweep, surfaced as the shadow
  // invoice's settled transaction_state — never the provider's `completed` state (see
  // OPENRECEIVE_SWAP_STATES). Once the order is paid the panel shows a final
  // confirmation, even if `provider_state` still lags on "confirming"/"exchanging".
  const settled = invoice.transaction_state === "settled" || invoice.settled_at !== undefined;

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
    ...(createOpenReceiveSwapFeeBreakdown(swap.fee) === undefined
      ? {}
      : { feeBreakdown: createOpenReceiveSwapFeeBreakdown(swap.fee) }),
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

function getOpenReceiveSwapProviderStateLabel(state: string): string {
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

function getOpenReceiveSwapAssetDisplay(payInAsset: string): {
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

export function escapeOpenReceiveHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function formatOpenReceiveMsats(amountMsats: number): string {
  if (!Number.isSafeInteger(amountMsats) || amountMsats < 0) {
    throw new RangeError("amount_msats must be a non-negative safe integer");
  }

  if (amountMsats % 1000 === 0) {
    const sats = amountMsats / 1000;
    return `${formatOpenReceiveInteger(sats)} ${sats === 1 ? "sat" : "sats"}`;
  }

  return `${formatOpenReceiveInteger(amountMsats)} msats`;
}

export function formatOpenReceiveFiatAmount(
  fiat:
    | {
        readonly currency?: string;
        readonly value?: string;
      }
    | null
    | undefined,
): string | undefined {
  if (fiat?.currency === undefined || fiat.value === undefined) return undefined;
  if (fiat.currency === "BTC") return `${fiat.value} BTC`;
  if (fiat.currency === "SATS") return `${fiat.value} sats`;
  return fiat.currency === "USD" ? `$${fiat.value}` : `${fiat.value} ${fiat.currency}`;
}

/** Combined QR caption, e.g. `19,174 sats / $12.00 US`. */
export function formatOpenReceiveAmountCaption(options: {
  readonly amountLabel?: string;
  readonly fiatLabel?: string;
  readonly fiatCurrency?: string;
}): string | undefined {
  const fiat =
    options.fiatLabel === undefined
      ? undefined
      : options.fiatCurrency === "USD" && !options.fiatLabel.endsWith(" US")
        ? `${options.fiatLabel} US`
        : options.fiatLabel;
  if (options.amountLabel !== undefined && fiat !== undefined) {
    return `${options.amountLabel} / ${fiat}`;
  }
  return options.amountLabel ?? fiat;
}

function formatOpenReceiveInteger(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * Renders an invoice-side (Lightning receive) msat limit as a short amount for
 * display under a disabled swap asset, e.g. "$10.00". Converts to the
 * checkout's own fiat currency using its rate; falls back to a sats figure when
 * the checkout is sats/BTC-denominated or no usable rate is available.
 *
 * Minimums ceil and maximums floor to the display scale so the note never
 * understates a floor or overstates a ceiling.
 */
export function formatOpenReceiveSwapLimit(
  checkout: {
    readonly amount_msats: number;
    readonly fiat?: { readonly currency: string; readonly value: string };
  },
  limitMsats: number | undefined,
  rounding: "ceil" | "floor" = "ceil",
): string | undefined {
  if (
    limitMsats === undefined ||
    !Number.isSafeInteger(limitMsats) ||
    limitMsats < 0 ||
    !Number.isSafeInteger(checkout.amount_msats) ||
    checkout.amount_msats <= 0
  ) {
    return undefined;
  }
  const fiat = checkout.fiat;
  if (fiat !== undefined && fiat.currency !== "SATS" && fiat.currency !== "BTC") {
    const scaled = scaleFiatLimitExact({
      fiatValue: fiat.value,
      amountMsats: checkout.amount_msats,
      limitMsats,
      rounding,
    });
    if (scaled !== undefined) {
      const formatted = formatOpenReceiveFiatAmount({
        currency: fiat.currency,
        value: scaled,
      });
      if (formatted !== undefined) return formatted;
    }
  }
  const sats = rounding === "floor" ? Math.floor(limitMsats / 1000) : Math.ceil(limitMsats / 1000);
  return `${sats} ${sats === 1 ? "sat" : "sats"}`;
}

/**
 * Exact `invoice_fiat * limit_msats / amount_msats` at two decimal places.
 * Uses bigint only — never binary floats.
 */
function scaleFiatLimitExact(input: {
  readonly fiatValue: string;
  readonly amountMsats: number;
  readonly limitMsats: number;
  readonly rounding: "ceil" | "floor";
}): string | undefined {
  const fiat = optionalDecimal(input.fiatValue);
  if (fiat === undefined || fiat.units <= 0n) return undefined;
  const outScale = 2;
  // result_units_at_2dp = round(fiat_units * limit / amount * 10^(2 - fiatScale))
  const numerator = fiat.units * BigInt(input.limitMsats) * 10n ** BigInt(outScale);
  const denominator = BigInt(input.amountMsats) * 10n ** BigInt(fiat.scale);
  if (denominator <= 0n) return undefined;
  const units =
    input.rounding === "floor" ? numerator / denominator : ceilDiv(numerator, denominator);
  return formatDecimal(units, outScale);
}

/**
 * Typed transport error for OpenReceive browser requests. Carries the server's
 * error semantics (status, shared error code, retryable hint, Retry-After) so
 * callers can back off instead of blind fixed-interval retries — and so hosts
 * can distinguish "retry" from "bug".
 */
export class OpenReceiveBrowserRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly retryable?: boolean;
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    options: {
      readonly status: number;
      readonly code?: string;
      readonly retryable?: boolean;
      readonly retryAfterSeconds?: number;
    },
  ) {
    super(message);
    this.name = "OpenReceiveBrowserRequestError";
    this.status = options.status;
    if (options.code !== undefined) this.code = options.code;
    if (options.retryable !== undefined) this.retryable = options.retryable;
    if (options.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/**
 * Read a fetch Response as JSON with error semantics preserved: non-OK
 * responses throw OpenReceiveBrowserRequestError (even when the body is not
 * JSON — a proxy's HTML 502 must not surface as a SyntaxError), and the
 * Retry-After header is captured when present.
 */
export async function readOpenReceiveJsonResponse(
  response: {
    readonly ok: boolean;
    readonly status: number;
    readonly headers?: { get(name: string): string | null };
    json(): Promise<unknown>;
  },
  fallbackMessage: string,
): Promise<unknown> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const record =
      body !== null && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
    const retryAfterRaw = Number(response.headers?.get?.("retry-after") ?? Number.NaN);
    throw new OpenReceiveBrowserRequestError(
      typeof record?.message === "string" ? record.message : fallbackMessage,
      {
        status: response.status,
        ...(typeof record?.code === "string" ? { code: record.code } : {}),
        ...(typeof record?.retryable === "boolean" ? { retryable: record.retryable } : {}),
        ...(Number.isFinite(retryAfterRaw) && retryAfterRaw > 0
          ? { retryAfterSeconds: retryAfterRaw }
          : {}),
      },
    );
  }
  return body;
}

export function formatOpenReceivePaymentHashLabel(hash: string): string {
  return hash.length <= 16 ? hash : `${hash.slice(0, 8)}...${hash.slice(-8)}`;
}

export function formatOpenReceiveUnixTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return String(seconds);
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function formatOpenReceiveInvoiceLabel(invoice: string): string {
  if (invoice.length <= 48) return invoice;
  return `${invoice.slice(0, 20)}…${invoice.slice(-16)}`;
}

/** Deposit networks that have a public block explorer in OpenReceive UI. */
export type OpenReceiveExplorerNetwork = "ETH" | "SOL" | "TRON";

/**
 * Resolve the chain network from a `pay_in_asset` like `USDT_ETH` / `SOL_SOL`.
 * Returns undefined for unknown or Lightning-only values.
 */
export function getOpenReceiveExplorerNetwork(
  payInAsset: string | undefined,
): OpenReceiveExplorerNetwork | undefined {
  if (payInAsset === undefined || payInAsset === "") return undefined;
  const network = payInAsset.includes("_")
    ? (payInAsset.split("_").at(-1) ?? payInAsset)
    : payInAsset;
  if (network === "ETH" || network === "SOL" || network === "TRON") return network;
  return undefined;
}

/**
 * Public block-explorer URL for an on-chain address or transaction.
 * Lightning identifiers are intentionally unsupported — use
 * {@link createOpenReceiveLightningInvoiceDecodeUrl} for bolt11.
 */
export function createOpenReceiveBlockExplorerUrl(options: {
  readonly payInAsset?: string;
  readonly network?: OpenReceiveExplorerNetwork | string;
  readonly kind: "address" | "tx";
  readonly value: string;
}): string | undefined {
  const value = options.value.trim();
  if (value === "") return undefined;
  const network =
    options.network === "ETH" || options.network === "SOL" || options.network === "TRON"
      ? options.network
      : getOpenReceiveExplorerNetwork(
          options.payInAsset ?? (typeof options.network === "string" ? options.network : undefined),
        );
  if (network === undefined) return undefined;
  const encoded = encodeURIComponent(value);
  if (network === "ETH") {
    return options.kind === "tx"
      ? `https://etherscan.io/tx/${encoded}`
      : `https://etherscan.io/address/${encoded}`;
  }
  if (network === "SOL") {
    return options.kind === "tx"
      ? `https://solscan.io/tx/${encoded}`
      : `https://solscan.io/account/${encoded}`;
  }
  return options.kind === "tx"
    ? `https://tronscan.org/#/transaction/${encoded}`
    : `https://tronscan.org/#/address/${encoded}`;
}

/**
 * Link to an external bolt11 decoder, as `{decodeLinkUrl}?invoice={bolt11}`.
 * Strips an optional `lightning:` URI prefix.
 *
 * Off unless the host names a decoder: a bolt11 carries the amount, payee and
 * description, and fetching it hands the payer's IP to that third party too, so
 * OpenReceive never picks one on the host's behalf. Omit `decodeLinkUrl` and no
 * link is rendered.
 */
export function createOpenReceiveLightningInvoiceDecodeUrl(
  invoice: string,
  decodeLinkUrl?: string,
): string | undefined {
  const base = decodeLinkUrl?.trim();
  if (base === undefined || base === "") return undefined;
  const raw = invoice.trim();
  if (raw === "") return undefined;
  const bolt11 = raw.toLowerCase().startsWith("lightning:") ? raw.slice("lightning:".length) : raw;
  if (bolt11 === "") return undefined;
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}invoice=${encodeURIComponent(bolt11)}`;
}

/**
 * External link metadata for a swap/transaction detail row (explorer or decode).
 */
export function createOpenReceiveDetailExternalLink(options: {
  readonly label: string;
  readonly value: string;
  readonly payInAsset?: string;
  /** Host-configured bolt11 decoder. Omitted, no decode link is offered. */
  readonly decodeLinkUrl?: string;
}): { readonly href: string; readonly hrefLabel: string } | undefined {
  const value = options.value.trim();
  if (value === "") return undefined;
  if (options.label === "Lightning invoice") {
    const href = createOpenReceiveLightningInvoiceDecodeUrl(value, options.decodeLinkUrl);
    return href === undefined
      ? undefined
      : { href, hrefLabel: openReceiveCheckoutLabels.decodeInvoice };
  }
  const kind =
    options.label === "Deposit address" ||
    options.label === "Refund address" ||
    options.label === "Address"
      ? "address"
      : options.label === "Deposit transaction" || options.label === "Refund transaction"
        ? "tx"
        : undefined;
  if (kind === undefined) return undefined;
  const href = createOpenReceiveBlockExplorerUrl({
    payInAsset: options.payInAsset,
    kind,
    value,
  });
  return href === undefined
    ? undefined
    : { href, hrefLabel: openReceiveCheckoutLabels.viewOnExplorer };
}

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

export function assertOpenReceiveDisplayInvoice(invoice: string): void {
  assertInvoice(invoice);
}

export function createCheckoutDisplayModel(data: CheckoutDisplayData): CheckoutDisplayModel {
  return {
    ...data,
    // Deferred checkout (checkout_lock) has no bolt11 yet — use empty URI as placeholder.
    lightning_uri:
      data.rail === "checkout_lock" || !data.invoice ? "" : createLightningUri(data.invoice),
    ...(data.amount_msats === undefined
      ? {}
      : { amountLabel: formatOpenReceiveMsats(data.amount_msats) }),
    ...(formatOpenReceiveFiatAmount(data.fiat_quote?.fiat) === undefined
      ? {}
      : { fiatLabel: formatOpenReceiveFiatAmount(data.fiat_quote?.fiat) }),
    ...(data.payment_hash === undefined
      ? {}
      : { paymentHashLabel: formatOpenReceivePaymentHashLabel(data.payment_hash) }),
    ...(data.transaction_state === undefined
      ? {}
      : { transactionStateLabel: data.transaction_state }),
  };
}

export function createLightningUri(invoice: string): string {
  assertInvoice(invoice);
  return `lightning:${invoice}`;
}

interface NormalizedRequestCheckoutOptions {
  readonly checkoutUrl: string | ((orderId: string) => string);
  readonly orderId: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly memo?: string;
  readonly metadata?: Record<string, unknown>;
}

function normalizeRequestCheckoutOptions(
  options: RequestCheckoutOptions,
): NormalizedRequestCheckoutOptions {
  const record = options as RequestCheckoutOptions & Record<string, unknown>;
  const orderId = optionalString(record.orderId ?? record.order_id);
  const metadata = optionalRecord(record.metadata);
  return {
    checkoutUrl: resolveRequestCheckoutTarget(options),
    orderId: orderId ?? "",
    fetch: options.fetch,
    headers: options.headers,
    ...(options.memo === undefined ? {} : { memo: options.memo }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

/**
 * Resolve where a checkout is created. An explicit `checkoutUrl` always wins; otherwise a
 * `prefix` (the base path the shipped router is mounted at) derives `${prefix}/checkouts`.
 * This is what lets a developer pass `prefix: "/openreceive"` and never spell out routes.
 */
function resolveRequestCheckoutTarget(
  options: RequestCheckoutOptions,
): string | ((orderId: string) => string) {
  if (options.checkoutUrl !== undefined) return options.checkoutUrl;
  const prefix = optionalString(options.prefix);
  if (prefix !== undefined) {
    return `${prefix.replace(/\/+$/, "")}/checkouts`;
  }
  throw new Error("OpenReceive checkout creation requires checkoutUrl or prefix.");
}

/**
 * Derive the payment-check URL from the base path the shipped router is mounted at.
 * The order id argument is retained because session/controller APIs are order-oriented.
 */
export function resolveOrderUrlFromPrefix(prefix: string, orderId: string): string {
  void orderId;
  return `${prefix.replace(/\/+$/, "")}/payments/check`;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OpenReceive metadata must be an object.");
  }
  return value as Record<string, unknown>;
}

export async function requestCheckout(options: RequestCheckoutOptions): Promise<CheckoutSnapshot> {
  const request = normalizeRequestCheckoutOptions(options);
  if (request.orderId.length === 0) {
    throw new Error("OpenReceive checkout creation requires orderId.");
  }

  const fetcher = request.fetch ?? globalThis.fetch;
  if (fetcher === undefined) {
    throw new Error("OpenReceive checkout creation requires fetch.");
  }

  if (request.memo !== undefined && request.memo.length > 500) {
    throw new Error("OpenReceive memo must be 500 characters or fewer.");
  }

  const requestBody = {
    order_id: request.orderId,
    ...(request.memo === undefined ? {} : { memo: request.memo }),
    ...(request.metadata === undefined ? {} : { metadata: structuredClone(request.metadata) }),
  };
  assertOpenReceiveBrowserPayloadSafe(requestBody);

  const headers = request.headers === undefined ? {} : request.headers;
  const response = await fetcher(resolveCheckoutUrl(request.checkoutUrl, request.orderId), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(requestBody),
  });
  const body = (await readOpenReceiveJsonResponse(response, "Could not create checkout.")) as
    | Record<string, unknown>
    | undefined;

  const snapshot = checkoutSnapshotFromResponseBody(body);
  const responseInvoice = snapshot.active;
  if (isRecord(responseInvoice) && typeof responseInvoice.invoice === "string") {
    assertOpenReceiveDisplayInvoice(responseInvoice.invoice);
  }

  return snapshot;
}

/**
 * Lock the host order amount and load payment methods without minting Lightning.
 * Bitcoin selection later calls {@link requestCheckout} to mint (or reuse) a bolt11.
 */
export async function prepareCheckout(options: RequestCheckoutOptions): Promise<CheckoutSnapshot> {
  const request = normalizeRequestCheckoutOptions(options);
  if (request.orderId.length === 0) {
    throw new Error("OpenReceive checkout prepare requires orderId.");
  }

  const fetcher = request.fetch ?? globalThis.fetch;
  if (fetcher === undefined) {
    throw new Error("OpenReceive checkout prepare requires fetch.");
  }

  const headers = request.headers === undefined ? {} : request.headers;
  const prepareUrl = resolveCheckoutPrepareUrl(request.checkoutUrl, request.orderId);
  const response = await fetcher(prepareUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify({ order_id: request.orderId }),
  });
  const body = await readOpenReceiveJsonResponse(response, "Could not prepare checkout.");

  return checkoutLockSnapshotFromPrepareBody(body, request.orderId);
}

export function createOpenReceiveStatusFetcher(
  options: CreateOpenReceiveStatusFetcherOptions,
): CheckoutStatusRefresh {
  return async (order_id) => {
    if (order_id.length === 0) {
      throw new Error("OpenReceive status refresh requires order_id.");
    }

    const fetcher = options.fetch ?? globalThis.fetch;
    if (fetcher === undefined) {
      throw new Error("OpenReceive status refresh requires fetch.");
    }

    const headers = options.headers === undefined ? {} : options.headers;
    const activePaymentHash =
      optionalString(options.snapshot.active?.payment_hash) ??
      (options.snapshot.active?.rail === "checkout_lock"
        ? undefined
        : optionalString(options.snapshot.active?.invoice_id));
    // Deferred checkout_lock has no attempt yet — skip wallet status until Lightning or swap.
    if (activePaymentHash === undefined || !/^[0-9a-f]{64}$/i.test(activePaymentHash)) {
      return options.snapshot;
    }
    const response = await fetcher(options.orderUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify({
        order_id,
        payment_hash: activePaymentHash,
      }),
    });
    const body = await readOpenReceiveJsonResponse(response, "Could not refresh invoice status.");

    const payment = asRecord(body);
    const next = structuredClone(options.snapshot);
    if (next.active === undefined) return next;
    const state = optionalString(payment.status) ?? "pending";
    let active = {
      ...next.active,
      transaction_state: state === "not_found" ? "pending" : state,
      ...(optionalSafeInteger(payment.paid_at) === undefined
        ? {}
        : { settled_at: optionalSafeInteger(payment.paid_at) }),
    };
    // A live swap needs the provider's state too: "confirming"/"exchanging"
    // progress, expiry, and critically refund_required can only come from
    // /swaps/status — /payments/check sees only the shadow invoice.
    if (
      active.rail === "swap" &&
      active.swap !== undefined &&
      state !== "settled" &&
      // A terminal provider state is final; re-reading it only adds provider load.
      !isTerminalSwapProviderState(optionalString(active.swap.provider_state))
    ) {
      try {
        const swapStatusUrl = `${openReceiveRoutePrefix(options.orderUrl)}/swaps/status`;
        const swapResponse = await fetcher(swapStatusUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...headers,
          },
          body: JSON.stringify({ order_id, payment_hash: activePaymentHash }),
        });
        const swapBody = asRecord(
          await readOpenReceiveJsonResponse(swapResponse, "Could not refresh swap status."),
        );
        active = mergeSwapStatusIntoInvoice(active, swapBody);
      } catch {
        // Live swap state is an enrichment; the shadow-invoice status above
        // still lands even when the provider read fails this tick.
      }
    }
    const paymentMethods = normalizePaymentMethods(payment.payment_methods);
    // Sibling attempts stay in the snapshot: an order can hold a live swap next
    // to a still-valid Lightning invoice, and dropping the sibling forced a
    // fresh POST /checkouts when the payer switched back to Lightning.
    const others = next.invoices.filter(
      (entry) => entry.invoice_id !== active.invoice_id && entry.rail !== "checkout_lock",
    );
    return {
      ...next,
      active,
      invoices: [active, ...others],
      status:
        state === "settled"
          ? "paid"
          : state === "expired" || state === "failed"
            ? "expired"
            : "open",
      ...(paymentMethods === undefined ? {} : { payment_methods: paymentMethods }),
    };
  };
}

/** Fold a bare PublicSwap status body into the invoice's swap snapshot. */
function mergeSwapStatusIntoInvoice<
  Invoice extends Pick<CheckoutInvoiceSnapshot, "swap" | "expires_at">,
>(invoice: Invoice, status: Record<string, unknown>): Invoice {
  const swap = invoice.swap;
  if (swap === undefined) return invoice;
  const merged: Record<string, unknown> = { ...swap };
  const providerState = optionalString(status.provider_state);
  if (providerState !== undefined) merged.provider_state = providerState;
  const providerExpiresAt = optionalSafeInteger(status.provider_expires_at);
  if (providerExpiresAt !== undefined) merged.provider_expires_at = providerExpiresAt;
  for (const key of [
    "deposit_tx_id",
    "payout_tx_id",
    "refund_tx_id",
    "refund_reason",
    "refund_amount",
    "deposit_received_amount",
    "refund_address",
    "refund_nonce",
    "attention_reason",
  ]) {
    if (typeof status[key] === "string") merged[key] = status[key];
  }
  if (typeof status.attention === "boolean") merged.attention = status.attention;
  if (
    (providerState === "refund_required" || merged.provider_state === "refund_required") &&
    merged.refund_nonce === undefined
  ) {
    merged.refund_nonce = OPENRECEIVE_REFUND_REVIEW_NONCE;
  }
  return {
    ...invoice,
    swap: merged as unknown as NonNullable<CheckoutInvoiceSnapshot["swap"]>,
    ...(providerExpiresAt === undefined ? {} : { expires_at: providerExpiresAt }),
  };
}

function resolveCheckoutUrl(
  checkoutUrl: string | ((orderId: string) => string),
  orderId: string,
): string {
  const url = typeof checkoutUrl === "function" ? checkoutUrl(orderId) : checkoutUrl;
  if (url.includes("{orderId}")) {
    return url.replaceAll("{orderId}", encodeURIComponent(orderId));
  }
  return url.includes("{order_id}")
    ? url.replaceAll("{order_id}", encodeURIComponent(orderId))
    : url;
}

function resolveCheckoutPrepareUrl(
  checkoutUrl: string | ((orderId: string) => string) | undefined,
  orderId: string,
): string {
  if (checkoutUrl !== undefined) {
    const minted = resolveCheckoutUrl(checkoutUrl, orderId);
    if (minted.endsWith("/checkouts")) return `${minted}/prepare`;
    if (minted.includes("/checkouts?")) {
      return minted.replace("/checkouts?", "/checkouts/prepare?");
    }
    // Silently falling back to the default prefix would split prepare and
    // create across DIFFERENT endpoints — fail loudly instead.
    throw new Error(
      "OpenReceive cannot derive the prepare URL from this checkoutUrl (it does not end in " +
        "/checkouts). Pass `prefix` instead, or point checkoutUrl at the mounted /checkouts route.",
    );
  }
  return `${OPENRECEIVE_DEFAULT_PREFIX}/checkouts/prepare`;
}

function checkoutLockSnapshotFromPrepareBody(
  body: unknown,
  fallbackOrderId: string,
): CheckoutSnapshot {
  const record = asRecord(body);
  const orderId = optionalString(record.order_id) ?? fallbackOrderId;
  const amountMsats = requiredSafeInteger(record.amount_msats, "amount_msats");
  const lockId = `lock:${orderId}`;
  const lockInvoice: CheckoutInvoiceSnapshot = {
    invoice_id: lockId,
    rail: "checkout_lock",
    amount_msats: amountMsats,
    transaction_state: "pending",
    workflow_state: "invoice_created",
  };
  const fiatQuote = record.fiat_quote;
  const fiat =
    isRecord(fiatQuote) && isRecord(fiatQuote.fiat)
      ? {
          currency: String(fiatQuote.fiat.currency ?? ""),
          value: String(fiatQuote.fiat.value ?? ""),
        }
      : undefined;
  const paymentMethods = normalizePaymentMethods(record.payment_methods);
  return {
    checkout_id: lockId,
    order_id: orderId,
    status: "open",
    amount_msats: amountMsats,
    ...(fiat !== undefined && fiat.currency.length > 0 ? { fiat } : {}),
    active: lockInvoice,
    invoices: [lockInvoice],
    ...(paymentMethods === undefined ? {} : { payment_methods: paymentMethods }),
  };
}

function checkoutSnapshotFromResponseBody(body: unknown): CheckoutSnapshot {
  const record = asRecord(body);
  const wrapped = asRecord(record.checkout);
  return checkoutSnapshot(wrapped);
}

function checkoutSnapshot(checkout: Record<string, unknown>): CheckoutSnapshot {
  const paymentHash = requiredString(checkout.payment_hash, "payment_hash");
  const orderId = requiredString(checkout.order_id, "order_id");
  const amountMsats = requiredSafeInteger(checkout.amount_msats, "amount_msats");
  const invoice: CheckoutInvoiceSnapshot = {
    invoice_id: paymentHash,
    rail: "lightning",
    invoice: requiredString(checkout.bolt11, "bolt11"),
    payment_hash: paymentHash,
    amount_msats: amountMsats,
    transaction_state: "pending",
    workflow_state: "invoice_created",
    expires_at: requiredSafeInteger(checkout.expires_at, "expires_at"),
    ...(isRecord(checkout.fiat_quote) || checkout.fiat_quote === null
      ? { fiat_quote: checkout.fiat_quote as CheckoutInvoiceSnapshot["fiat_quote"] }
      : {}),
  };
  return {
    checkout_id: paymentHash,
    order_id: orderId,
    status: "open",
    amount_msats: amountMsats,
    active: invoice,
    invoices: [invoice],
  };
}

function requiredInvoiceRail(value: unknown): CheckoutInvoiceSnapshot["rail"] {
  if (value === "lightning" || value === "swap" || value === "checkout_lock") return value;
  throw new TypeError("OpenReceive invoice rail must be lightning, swap, or checkout_lock.");
}

/**
 * Choose the invoice the checkout UI should treat as primary.
 *
 * Prefers the active payable invoice; otherwise a bolt11-bearing invoice (Lightning),
 * preferring one that has settled. After a swap settles alongside a Lightning invoice,
 * the newest entry is often the settled swap shadow (rail "swap", no public bolt11) —
 * fall back to the payable Lightning invoice for QR/copy display.
 *
 * When Lightning was never minted (deferred create + swap-only), return the swap invoice
 * so settlement still drives paid/`onSettled` UI even though bolt11 is omitted.
 *
 * `checkout_lock` rails are deferred placeholders and are skipped. Returns `undefined`
 * only when the checkout still has only a checkout_lock (or no invoices).
 */
export function selectCheckoutDisplayInvoice(
  snapshot: CheckoutSnapshot,
): CheckoutInvoiceSnapshot | undefined {
  // Skip checkout_lock (deferred placeholder) — it has no bolt11 to display.
  if (snapshot.active !== undefined && snapshot.active.rail !== "checkout_lock") {
    return snapshot.active;
  }
  const nonLock = snapshot.invoices.filter((invoice) => invoice.rail !== "checkout_lock");
  const withBolt11 = nonLock.filter(
    (invoice) => typeof invoice.invoice === "string" && invoice.invoice.length > 0,
  );
  const settledBolt11 = withBolt11.find(
    (invoice) => invoice.transaction_state === "settled" || invoice.settled_at !== undefined,
  );
  if (settledBolt11 !== undefined) return settledBolt11;
  // Prefer a payable Lightning invoice for QR/copy when one exists (even next to a
  // settled swap shadow).
  if (withBolt11[0] !== undefined) return withBolt11[0];
  // Swap-only checkout: surface the swap invoice (null bolt11) so settlement is visible.
  const settledSwap = nonLock.find(
    (invoice) => invoice.transaction_state === "settled" || invoice.settled_at !== undefined,
  );
  return settledSwap ?? nonLock[0];
}

export function checkoutInvoiceFromOrderSnapshot(
  snapshot: CheckoutSnapshot,
): CheckoutInvoiceSnapshot {
  const invoice = selectCheckoutDisplayInvoice(snapshot);
  if (invoice === undefined) {
    throw new TypeError("OpenReceive order snapshot requires active or invoices[0].");
  }
  return invoice;
}

export function isPaidCheckoutSnapshot(snapshot: CheckoutSnapshot): boolean {
  return snapshot.status === "paid";
}

/**
 * True when the given Lightning invoice has more than {@link OPENRECEIVE_LIGHTNING_REUSE_BUFFER_SECONDS}
 * seconds remaining. Pass an optional `now` (Unix seconds) for deterministic tests; defaults to the
 * current clock.
 */
export function isReusableLightningInvoice(expiresAt: number, now?: number): boolean {
  return expiresAt - (now ?? currentUnixSeconds()) > OPENRECEIVE_LIGHTNING_REUSE_BUFFER_SECONDS;
}

export function createCheckoutState(
  snapshot: CheckoutSnapshot,
  options: CreateCheckoutStateOptions = {},
): CheckoutState {
  const invoiceRecord = selectCheckoutDisplayInvoice(snapshot);

  if (invoiceRecord === undefined) {
    // Deferred checkout — no bolt11 minted yet. Return a minimal open/pending state so
    // callers (useCheckout, CheckoutWatcher) don't throw. The invoice fields are empty
    // strings; callers MUST gate any bolt11-dependent UI on the lightning pane being shown.
    return {
      checkout_id: snapshot.checkout_id,
      order_id: snapshot.order_id,
      invoice_id: "",
      invoice: "",
      rail: "checkout_lock",
      lightning_uri: "",
      ...(snapshot.amount_msats === undefined ? {} : { amount_msats: snapshot.amount_msats }),
      ...(snapshot.fiat !== undefined ? { fiat_quote: { fiat: snapshot.fiat } } : {}),
      transaction_state: "pending",
      workflow_state: "invoice_created",
      phase: "invoice_created",
      settled: false,
      terminal: false,
      paid: false,
    };
  }

  const invoice = invoiceRecord;
  // Swap shadows intentionally omit bolt11 from public payloads; checkout_lock has none yet.
  const bolt11 =
    typeof invoice.invoice === "string" && invoice.invoice.length > 0
      ? invoice.invoice
      : invoice.rail === "swap" || invoice.rail === "checkout_lock"
        ? ""
        : requiredString(invoice.invoice, "invoice");
  const paid = isPaidCheckoutSnapshot(snapshot);
  const settledAt = snapshot.paid_at ?? invoice.settled_at;
  const transactionState = paid ? "settled" : (invoice.transaction_state ?? "pending");
  const workflowState = paid ? "paid" : (invoice.workflow_state ?? "invoice_created");

  const state = normalizeCheckoutState(
    {
      checkout_id: snapshot.checkout_id,
      order_id: snapshot.order_id,
      invoice_id: invoice.invoice_id,
      invoice: bolt11,
      rail: invoice.rail,
      lightning_uri:
        invoice.rail === "checkout_lock" || invoice.rail === "swap" || bolt11 === ""
          ? ""
          : createLightningUri(bolt11),
      ...(invoice.payment_hash === undefined ? {} : { payment_hash: invoice.payment_hash }),
      amount_msats: invoice.amount_msats ?? snapshot.amount_msats,
      ...(invoice.fiat_quote === undefined ? {} : { fiat_quote: invoice.fiat_quote }),
      transaction_state: transactionState,
      workflow_state: workflowState,
      ...(invoice.expires_at === undefined ? {} : { expires_at: invoice.expires_at }),
      ...(settledAt === undefined ? {} : { settled_at: settledAt }),
      ...(invoice.swap === undefined ? {} : { swap: invoice.swap }),
      paid,
    },
    options.now ?? currentUnixSeconds(),
  );
  const source = options.source ?? "create";
  if (source === "create") {
    emitBrowserLog(
      options.logger,
      "info",
      "checkout.state.created",
      "Created checkout state from order snapshot.",
      checkoutLogFields(state),
    );
  } else if (source === "refresh") {
    emitBrowserLog(
      options.logger,
      "debug",
      "checkout.state.refreshed",
      "Refreshed checkout state from order status.",
      checkoutLogFields(state),
    );
    emitBrowserSwapTransition(options.logger, options.previousState, state);
  }
  return state;
}

export function createCheckoutSnapshotFromDisplayData(data: CheckoutDisplayData): CheckoutSnapshot {
  const rail = requiredInvoiceRail(data.rail);
  const invoiceId = requiredString(data.invoice_id, "invoice_id");
  const invoice: CheckoutInvoiceSnapshot = {
    invoice_id: invoiceId,
    invoice: data.invoice,
    rail,
    ...(data.payment_hash === undefined ? {} : { payment_hash: data.payment_hash }),
    ...(data.amount_msats === undefined ? {} : { amount_msats: data.amount_msats }),
    ...(data.fiat_quote === undefined ? {} : { fiat_quote: data.fiat_quote }),
    ...(data.transaction_state === undefined ? {} : { transaction_state: data.transaction_state }),
    ...(data.workflow_state === undefined ? {} : { workflow_state: data.workflow_state }),
    ...(data.expires_at === undefined ? {} : { expires_at: data.expires_at }),
    ...(data.settled_at === undefined ? {} : { settled_at: data.settled_at }),
    ...(data.swap === undefined ? {} : { swap: data.swap }),
  };
  const paid = data.settled_at !== undefined || data.transaction_state === "settled";
  const checkoutId = data.checkout_id ?? invoiceId;
  return {
    checkout_id: checkoutId,
    order_id: data.order_id ?? invoiceId,
    status: paid ? "paid" : "open",
    ...(data.settled_at === undefined ? {} : { paid_at: data.settled_at }),
    amount_msats: data.amount_msats ?? 0,
    active: paid ? undefined : invoice,
    invoices: [invoice],
  };
}

export function createCheckoutStateFromDisplayData(
  data: CheckoutDisplayData,
  options: CreateCheckoutStateOptions = {},
): CheckoutState {
  return createCheckoutState(createCheckoutSnapshotFromDisplayData(data), options);
}

export function refreshCheckoutState(
  state: CheckoutState,
  options: CreateCheckoutStateOptions = {},
): CheckoutState {
  return createCheckoutState(snapshotFromCheckoutState(state), {
    ...options,
    source: options.source ?? "countdown",
    previousState: options.previousState ?? state,
  });
}

export function shouldCheckoutShowWaiting(
  state: CheckoutState,
  options: { readonly now?: number } = {},
): boolean {
  if (state.terminal || state.settled) return false;
  if (state.expires_at === undefined) return true;
  return state.expires_at > (options.now ?? currentUnixSeconds());
}

export function createCheckoutStatusModel(
  source?: CheckoutState | CheckoutStatusModelInput,
  options: { readonly now?: number } = {},
): CheckoutStatusModel {
  const isCheckoutState = source !== undefined && "invoice_id" in source && "invoice" in source;
  const phase = source?.phase ?? "invoice_created";
  const expiresInSeconds = source?.expires_in_seconds;
  const displayPhase =
    phase !== "settled" && phase !== "failed" && phase !== "cancelled" && expiresInSeconds === 0
      ? "expired"
      : phase;
  const statusText = getOpenReceivePaymentStatusText(displayPhase);

  return {
    phase: displayPhase,
    waiting:
      displayPhase === "expired"
        ? false
        : source === undefined
          ? false
          : isCheckoutState
            ? shouldCheckoutShowWaiting(source, options)
            : (source.waiting ?? false),
    title: statusText.title,
    detail: statusText.detail,
    countdownPrefix: openReceiveCheckoutLabels.countdownPrefix,
    // No countdown once settled — the invoice's remaining lifetime is meaningless
    // to a payer whose payment already landed.
    ...(expiresInSeconds === undefined || displayPhase === "expired" || displayPhase === "settled"
      ? {}
      : {
          expires_in_seconds: expiresInSeconds,
          countdownLabel: formatOpenReceiveCountdown(expiresInSeconds),
        }),
  };
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

export class CheckoutWatcher {
  private options: CheckoutWatcherOptions;
  private state: CheckoutState | undefined;
  private countdownTimer: ReturnType<typeof globalThis.setInterval> | undefined;
  private pollTimer: ReturnType<typeof globalThis.setInterval> | undefined;
  private running = false;
  private pollInFlight = false;
  private pollFailureCount = 0;
  private pollBackoffUntil: number | undefined;

  constructor(options: CheckoutWatcherOptions) {
    this.options = options;
  }

  start(): CheckoutState {
    this.stop();
    this.running = true;
    this.options.onSnapshot?.(this.options.snapshot);
    const state = createCheckoutState(this.options.snapshot, {
      now: this.now(),
      logger: this.options.logger,
    });
    this.applyState(state);
    return state;
  }

  stop(): void {
    this.running = false;
    this.stopCountdown();
    this.stopPolling();
  }

  getState(): CheckoutState | undefined {
    return this.state;
  }

  /**
   * Stop and enter the terminal `cancelled` phase. Unlike {@link stop}, the
   * watcher's own state moves, so later reads report `cancelled` instead of the
   * last polled state.
   */
  cancel(): CheckoutState {
    const current =
      this.state ??
      createCheckoutState(this.options.snapshot, {
        now: this.now(),
        logger: this.options.logger,
      });
    this.stop();
    // A settled attempt is already terminal and its money has moved: cancelling
    // it would only lie to the payer.
    if (current.settled) {
      this.state = current;
      return current;
    }
    const cancelled = normalizeCheckoutState(
      { ...current, workflow_state: "cancelled" },
      this.now(),
    );
    this.state = cancelled;
    this.options.onState(cancelled);
    return cancelled;
  }

  async reloadState(): Promise<CheckoutState> {
    const current =
      this.state ??
      createCheckoutState(this.options.snapshot, {
        now: this.now(),
        logger: this.options.logger,
      });
    const refreshStatus = this.options.refreshStatus;
    if (refreshStatus === undefined || current.order_id.length === 0) {
      return current;
    }

    try {
      const next = await refreshStatus(current.order_id);
      if (next === null) return current;
      this.options.onSnapshot?.(next);
      const nextState = createCheckoutState(next, {
        now: this.now(),
        logger: this.options.logger,
        source: "refresh",
        previousState: current,
      });
      if (this.running) {
        this.applyState(nextState);
      } else {
        this.state = nextState;
      }
      return nextState;
    } catch (error) {
      this.options.onError?.(error);
      throw error;
    }
  }

  private applyState(state: CheckoutState): void {
    if (!this.running) return;
    this.state = state;
    this.options.onState(state);
    this.syncWatchers();
  }

  private syncWatchers(): void {
    const state = this.state;
    if (state === undefined || !this.running) return;

    if (state.terminal) {
      this.stop();
      return;
    }

    if (state.settled || state.expires_at === undefined) {
      this.stopCountdown();
    } else if (this.countdownTimer === undefined) {
      this.countdownTimer = this.setInterval()(() => {
        const current = this.state;
        if (current === undefined) return;
        this.applyState(
          refreshCheckoutState(current, {
            now: this.now(),
            logger: this.options.logger,
            source: "countdown",
          }),
        );
      }, 1000);
    }

    const canPollAttempt =
      state.rail !== "checkout_lock" &&
      typeof state.payment_hash === "string" &&
      /^[0-9a-f]{64}$/i.test(state.payment_hash);
    if (
      state.settled ||
      this.options.refreshStatus === undefined ||
      state.order_id.length === 0 ||
      !canPollAttempt
    ) {
      this.stopPolling();
    } else if (this.pollTimer === undefined) {
      this.pollTimer = this.setInterval()(() => {
        void this.poll();
      }, this.options.pollIntervalMs ?? OPENRECEIVE_DEFAULT_POLL_INTERVAL_MS);
    }
  }

  private async poll(): Promise<void> {
    const refreshStatus = this.options.refreshStatus;
    const current = this.state;
    if (!this.running || refreshStatus === undefined || current === undefined) return;
    if (current.terminal || current.settled) {
      this.stopPolling();
      return;
    }
    // One request at a time: a slow backend must not stack overlapping polls
    // (which multiply load exactly when it is struggling, and whose stale
    // responses could arrive out of order).
    if (this.pollInFlight) return;
    // Failed polls back off (honoring the server's Retry-After when present)
    // instead of hammering at the fixed interval.
    if (this.pollBackoffUntil !== undefined && this.now() < this.pollBackoffUntil) return;
    this.pollInFlight = true;

    try {
      const next = await refreshStatus(current.order_id);
      this.pollFailureCount = 0;
      this.pollBackoffUntil = undefined;
      if (next === null) return;
      if (!this.running || this.state === undefined) return;
      // A response that raced a settlement must never flip a paid screen
      // back to "waiting for payment".
      if (this.state.settled || this.state.terminal) return;
      this.options.onSnapshot?.(next);
      this.applyState(
        createCheckoutState(next, {
          now: this.now(),
          logger: this.options.logger,
          source: "refresh",
          previousState: this.state,
        }),
      );
    } catch (error) {
      this.pollFailureCount += 1;
      const retryAfterSeconds =
        error instanceof OpenReceiveBrowserRequestError ? error.retryAfterSeconds : undefined;
      const backoffSeconds =
        retryAfterSeconds ?? Math.min(60, 2 ** Math.min(this.pollFailureCount, 6));
      this.pollBackoffUntil = this.now() + backoffSeconds;
      this.options.onError?.(error);
    } finally {
      this.pollInFlight = false;
    }
  }

  private stopCountdown(): void {
    if (this.countdownTimer === undefined) return;
    this.clearInterval()(this.countdownTimer);
    this.countdownTimer = undefined;
  }

  private stopPolling(): void {
    if (this.pollTimer === undefined) return;
    this.clearInterval()(this.pollTimer);
    this.pollTimer = undefined;
  }

  private now(): number {
    return this.options.now?.() ?? currentUnixSeconds();
  }

  private setInterval(): typeof globalThis.setInterval {
    return this.options.setInterval ?? globalThis.setInterval;
  }

  private clearInterval(): typeof globalThis.clearInterval {
    return this.options.clearInterval ?? globalThis.clearInterval;
  }
}

export class OpenReceiveBrowserCheckoutController implements CheckoutController {
  private options: CheckoutControllerOptions;
  private watcher: CheckoutWatcher;
  private state: CheckoutState | undefined;

  constructor(options: CheckoutControllerOptions) {
    this.options = options;
    this.watcher = this.createWatcher(options);
  }

  start(): CheckoutState {
    this.state = this.watcher.start();
    return this.state;
  }

  stop(): void {
    this.watcher.stop();
  }

  getState(): CheckoutState | undefined {
    // The watcher owns state. A stopped watcher still applies reloadState()
    // results to itself without calling back, so preferring the controller's
    // last observed copy would serve a stale state after stop().
    return this.watcher.getState() ?? this.state;
  }

  async copyInvoice(): Promise<void> {
    const state = this.currentState();
    await copyInvoice({
      invoice: state.invoice,
      clipboard: this.options.clipboard,
      logger: this.options.logger,
      logContext: checkoutLogFields(state),
    });
  }

  openWallet(): string {
    const state = this.currentState();
    return openWallet({
      invoice: state.invoice,
      open: this.options.open,
      logger: this.options.logger,
      logContext: checkoutLogFields(state),
    });
  }

  async reloadState(): Promise<CheckoutState> {
    return this.watcher.reloadState();
  }

  cancel(): CheckoutState {
    this.state = this.watcher.cancel();
    emitBrowserLog(
      this.options.logger,
      "info",
      "checkout.cancelled",
      "Cancelled checkout and stopped the watcher.",
      checkoutLogFields(this.state),
    );
    return this.state;
  }

  private createWatcher(options: CheckoutControllerOptions): CheckoutWatcher {
    const refreshStatus =
      options.refreshStatus ??
      (options.orderUrl === undefined
        ? undefined
        : createOpenReceiveStatusFetcher({
            orderUrl: options.orderUrl,
            snapshot: options.snapshot,
            fetch: options.fetch,
            headers: options.statusHeaders,
          }));

    return new CheckoutWatcher({
      ...options,
      ...(refreshStatus === undefined ? {} : { refreshStatus }),
      onState: (state) => {
        this.state = state;
        options.onState?.(state);
      },
      ...(options.onSnapshot === undefined ? {} : { onSnapshot: options.onSnapshot }),
    });
  }

  private currentState(): CheckoutState {
    return (
      this.getState() ??
      createCheckoutState(this.options.snapshot, {
        now: this.options.now?.(),
        logger: this.options.logger,
      })
    );
  }
}

export function createCheckoutController(options: CheckoutControllerOptions): CheckoutController {
  return new OpenReceiveBrowserCheckoutController(options);
}

export async function createQrSvg(
  invoice: string,
  options: OpenReceiveQrOptions = {},
): Promise<string> {
  return await createQrPayloadSvg(createLightningUri(invoice), options);
}

export async function createQrPayloadSvg(
  payload: string,
  options: OpenReceiveQrOptions = {},
): Promise<string> {
  const encoder = await getQrEncoder(options.encoder);
  const svg = await encoder.toString(payload, {
    type: "svg",
    errorCorrectionLevel: OPENRECEIVE_QR_ERROR_CORRECTION,
    margin: OPENRECEIVE_QR_QUIET_ZONE_MODULES,
    width: options.width,
    color: {
      dark: OPENRECEIVE_QR_DARK_COLOR,
      light: OPENRECEIVE_QR_LIGHT_COLOR,
    },
  });

  return String(svg);
}

export async function createQrPngDataUrl(
  invoice: string,
  options: OpenReceiveQrOptions = {},
): Promise<string> {
  const encoder = await getQrEncoder(options.encoder);

  if (encoder.toDataURL === undefined) {
    throw new Error("QR encoder does not support PNG data URL output.");
  }

  const png = await encoder.toDataURL(createLightningUri(invoice), {
    type: "image/png",
    errorCorrectionLevel: OPENRECEIVE_QR_ERROR_CORRECTION,
    margin: OPENRECEIVE_QR_QUIET_ZONE_MODULES,
    width: options.width,
    color: {
      dark: OPENRECEIVE_QR_DARK_COLOR,
      light: OPENRECEIVE_QR_LIGHT_COLOR,
    },
  });

  return String(png);
}

export async function copyInvoice(options: CopyInvoiceOptions): Promise<void> {
  assertInvoice(options.invoice);
  const clipboard = options.clipboard ?? globalThis.navigator?.clipboard;

  if (clipboard === undefined) {
    throw new Error("Clipboard API is unavailable.");
  }

  await clipboard.writeText(options.invoice);
  emitBrowserLog(
    options.logger,
    "info",
    "checkout.invoice.copied",
    "Copied Lightning invoice to clipboard.",
    options.logContext,
  );
}

export function openWallet(options: OpenWalletOptions): string {
  const uri = createLightningUri(options.invoice);

  if (options.open !== undefined) {
    options.open(uri);
    emitBrowserLog(
      options.logger,
      "info",
      "checkout.wallet.opened",
      "Opened Lightning invoice URI.",
      options.logContext,
    );
    return uri;
  }

  const location = globalThis.window?.location;
  if (location === undefined) {
    throw new Error("window.location is unavailable.");
  }

  location.assign(uri);
  emitBrowserLog(
    options.logger,
    "info",
    "checkout.wallet.opened",
    "Opened Lightning invoice URI.",
    options.logContext,
  );
  return uri;
}

async function getQrEncoder(
  encoder: OpenReceiveQrEncoder | undefined,
): Promise<OpenReceiveQrEncoder> {
  if (encoder !== undefined) return encoder;
  if (isQrEncoder(defaultQrEncoder)) return defaultQrEncoder;

  let dynamicImport: (specifier: string) => Promise<unknown>;
  try {
    // Indirection keeps bundlers from statically resolving the optional
    // dependency; a strict CSP (no unsafe-eval) rejects Function construction.
    dynamicImport = new Function("specifier", "return import(specifier)") as (
      specifier: string,
    ) => Promise<unknown>;
  } catch {
    throw new Error(
      "QR encoding needs the optional qrcode package, and this page's Content-Security-Policy " +
        'blocks dynamic loading. Pass a qrEncoder explicitly (e.g. import QRCode from "qrcode").',
    );
  }
  const imported = asRecord(await dynamicImport("qrcode"));
  const candidate = (imported.default ?? imported) as unknown;

  if (isQrEncoder(candidate)) return candidate;

  throw new Error("qrcode package did not expose a compatible encoder.");
}

function isQrEncoder(value: unknown): value is OpenReceiveQrEncoder {
  const record = asRecord(value);
  // Every object inherits Object.prototype.toString, so probing for `toString`
  // alone accepts anything — and a wrong import would then silently render a QR
  // of "[object Object]". Require the module's own encoder entry points.
  return (
    typeof record.toString === "function" &&
    record.toString !== Object.prototype.toString &&
    (typeof record.create === "function" || typeof record.toDataURL === "function")
  );
}

function assertInvoice(invoice: string): void {
  if (typeof invoice !== "string" || invoice.length === 0) {
    throw new TypeError("invoice must be a non-empty BOLT11 string");
  }

  if (invoice.startsWith("nostr+walletconnect://")) {
    throw new TypeError("invoice must not be an NWC connection string");
  }
}

function assertOpenReceiveBrowserPayloadSafe(value: unknown): void {
  if (typeof value === "string") {
    if (value.startsWith("nostr+walletconnect://")) {
      throw new TypeError("OpenReceive browser payload must not include an NWC connection string");
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) assertOpenReceiveBrowserPayloadSafe(item);
    return;
  }

  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) {
      assertOpenReceiveBrowserPayloadSafe(item);
    }
  }
}

function normalizeCheckoutState(
  state: Omit<CheckoutState, "phase" | "settled" | "terminal" | "expires_in_seconds"> &
    Partial<Pick<CheckoutState, "phase" | "settled" | "terminal" | "expires_in_seconds">>,
  now?: number,
): CheckoutState {
  const {
    phase: _phase,
    settled: _settled,
    terminal: _terminal,
    expires_in_seconds: _expiresInSeconds,
    ...base
  } = state;
  const statePhase = getCheckoutPhase(state.transaction_state, state.workflow_state);
  const expiresInSeconds =
    base.expires_at === undefined || now === undefined
      ? undefined
      : Math.max(0, base.expires_at - now);
  const phase =
    statePhase === "invoice_created" || statePhase === "verifying"
      ? expiresInSeconds === 0
        ? "expired"
        : statePhase
      : statePhase;

  const settled = base.paid || base.transaction_state === "settled";

  return {
    ...base,
    phase,
    settled,
    // A swap that expired, refunded, failed, or needs support review is over:
    // the shadow invoice behind it will not be paid, so watchers stop polling
    // both /payments/check and the provider instead of asking forever.
    terminal:
      isTerminalPhase(phase) ||
      (!settled && isTerminalSwapProviderState(base.swap?.provider_state)),
    ...(expiresInSeconds === undefined ? {} : { expires_in_seconds: expiresInSeconds }),
  };
}

function getCheckoutPhase(transactionState: string, workflowState: string): CheckoutPhase {
  if (workflowState === "cancelled") return "cancelled";
  if (transactionState === "settled") return "settled";
  if (transactionState === "expired" || workflowState === "expired") {
    return "expired";
  }
  if (transactionState === "failed" || workflowState === "failed") {
    return "failed";
  }
  if (workflowState === "verifying") {
    return "verifying";
  }
  return "invoice_created";
}

function isTerminalPhase(phase: CheckoutPhase): boolean {
  return phase === "expired" || phase === "failed" || phase === "cancelled";
}

/**
 * Provider states this attempt can never leave, mirroring the engine's swap
 * state table (`terminal: true` there). `refund_required`/`refund_pending` are
 * deliberately absent: the payer still acts on the first, and the second must
 * keep polling to observe the provider reaching `refunded`.
 */
function isTerminalSwapProviderState(providerState: string | undefined): boolean {
  return (
    providerState === "expired" ||
    providerState === "refunded" ||
    providerState === "attention" ||
    providerState === "failed"
  );
}

function snapshotFromCheckoutState(state: CheckoutState): CheckoutSnapshot {
  const invoice: CheckoutInvoiceSnapshot = {
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
  };
  return {
    checkout_id: state.checkout_id,
    order_id: state.order_id,
    status: state.paid ? "paid" : state.terminal ? "expired" : "open",
    ...(state.settled_at === undefined ? {} : { paid_at: state.settled_at }),
    amount_msats: state.amount_msats ?? 0,
    active: state.paid ? undefined : invoice,
    invoices: [invoice],
  };
}

function currentUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function checkoutLogFields(state: {
  readonly checkout_id?: string;
  readonly order_id?: string;
  readonly invoice_id?: string;
  readonly payment_hash?: string;
  readonly amount_msats?: number;
  readonly transaction_state?: string;
  readonly workflow_state?: string;
  readonly phase?: string;
  readonly expires_in_seconds?: number;
  readonly settled?: boolean;
  readonly paid?: boolean;
  readonly rail?: string;
  readonly swap?: {
    readonly attempt_id?: string;
    readonly provider?: string;
    readonly provider_order_id?: string;
    readonly pay_in_asset?: string;
    readonly provider_state?: string;
    readonly attention?: boolean;
    readonly attention_reason?: string;
    readonly refund_nonce?: string;
    readonly refund_nonce_expires_at?: number;
    readonly refund_tx_id?: string;
    readonly deposit_tx_id?: string;
    readonly payout_tx_id?: string;
  };
}): Record<string, unknown> {
  return {
    ...(state.checkout_id === undefined ? {} : { checkout_id: state.checkout_id }),
    ...(state.order_id === undefined ? {} : { order_id: state.order_id }),
    ...(state.invoice_id === undefined ? {} : { invoice_id: state.invoice_id }),
    ...(state.payment_hash === undefined ? {} : { payment_hash: state.payment_hash }),
    ...(state.amount_msats === undefined ? {} : { amount_msats: state.amount_msats }),
    ...(state.transaction_state === undefined
      ? {}
      : { transaction_state: state.transaction_state }),
    ...(state.workflow_state === undefined ? {} : { workflow_state: state.workflow_state }),
    ...(state.phase === undefined ? {} : { phase: state.phase }),
    ...(state.expires_in_seconds === undefined
      ? {}
      : { expires_in_seconds: state.expires_in_seconds }),
    ...(state.settled === undefined ? {} : { settled: state.settled }),
    ...(state.paid === undefined ? {} : { paid: state.paid }),
    ...(state.rail === undefined ? {} : { rail: state.rail }),
    ...swapAuditLogFields(state.swap),
  };
}

function swapAuditLogFields(
  swap:
    | {
        readonly attempt_id?: string;
        readonly provider?: string;
        readonly provider_order_id?: string;
        readonly pay_in_asset?: string;
        readonly provider_state?: string;
        readonly attention?: boolean;
        readonly attention_reason?: string;
        readonly refund_reason?: string;
        readonly refund_nonce?: string;
        readonly refund_nonce_expires_at?: number;
        readonly refund_tx_id?: string;
        readonly deposit_tx_id?: string;
        readonly payout_tx_id?: string;
      }
    | undefined,
): Record<string, unknown> {
  if (swap === undefined) return {};
  return {
    ...(swap.attempt_id === undefined ? {} : { attempt_id: swap.attempt_id }),
    ...(swap.provider === undefined ? {} : { provider: swap.provider }),
    ...(swap.provider_order_id === undefined ? {} : { provider_order_id: swap.provider_order_id }),
    ...(swap.pay_in_asset === undefined ? {} : { pay_in_asset: swap.pay_in_asset }),
    ...(swap.provider_state === undefined ? {} : { provider_state: swap.provider_state }),
    ...(swap.attention === undefined ? {} : { attention: swap.attention }),
    ...(swap.attention_reason === undefined ? {} : { attention_reason: swap.attention_reason }),
    ...(swap.refund_reason === undefined ? {} : { refund_reason: swap.refund_reason }),
    refund_nonce_present: swap.refund_nonce !== undefined,
    ...(swap.refund_nonce_expires_at === undefined
      ? {}
      : { refund_nonce_expires_at: swap.refund_nonce_expires_at }),
    ...(swap.refund_tx_id === undefined ? {} : { refund_tx_id: swap.refund_tx_id }),
    ...(swap.deposit_tx_id === undefined ? {} : { deposit_tx_id: swap.deposit_tx_id }),
    ...(swap.payout_tx_id === undefined ? {} : { payout_tx_id: swap.payout_tx_id }),
  };
}

function emitBrowserSwapTransition(
  logger: OpenReceiveBrowserLoggerOption | undefined,
  previous: CheckoutState | undefined,
  next: CheckoutState,
): void {
  const previousSwap = previous?.swap;
  const nextSwap = next.swap;
  if (nextSwap === undefined) return;

  const previousState = previousSwap?.provider_state;
  const nextState = nextSwap.provider_state;
  const previousNonce = previousSwap?.refund_nonce !== undefined;
  const nextNonce = nextSwap.refund_nonce !== undefined;
  const previousAttention = previousSwap?.attention_reason;
  const nextAttention = nextSwap.attention_reason;
  const previousSettled = previous?.settled === true || previous?.paid === true;
  const nextSettled = next.settled === true || next.paid === true;

  const stateChanged = previousState !== nextState;
  const nonceChanged = previousNonce !== nextNonce;
  const attentionChanged = previousAttention !== nextAttention;
  const settlementChanged = previousSettled !== nextSettled;
  if (!stateChanged && !nonceChanged && !attentionChanged && !settlementChanged) return;

  const level: OpenReceiveBrowserLogLevel =
    nextState === "attention" || nextSwap.attention === true
      ? "warn"
      : nextState === "refund_required" ||
          nextState === "refund_pending" ||
          nextState === "refunded" ||
          nextState === "failed" ||
          nextState === "expired" ||
          settlementChanged
        ? "info"
        : "debug";

  emitBrowserLog(
    logger,
    level,
    "swap.state.changed",
    "Swap attempt state changed in checkout UI.",
    {
      ...checkoutLogFields(next),
      previous_provider_state: previousState,
      previous_settled: previousSettled,
      wallet_settled: nextSettled,
      ui_label: nextSettled ? "Payment complete" : getOpenReceiveSwapProviderStateLabel(nextState),
    },
  );
}

function emitBrowserLog(
  logger: OpenReceiveBrowserLoggerOption | undefined,
  level: OpenReceiveBrowserLogLevel,
  event: string,
  message: string,
  fields: Record<string, unknown> = {},
): void {
  const sink = resolveOpenReceiveBrowserLogger(logger);
  if (sink === undefined) return;

  try {
    sink(
      sanitizeBrowserLogEntry({
        level,
        event,
        message,
        ...fields,
      }),
    );
  } catch {
    // Checkout logs are diagnostic only and must not affect user actions.
  }
}

/**
 * Redact secrets from a browser log entry before it reaches a logger. Any field whose key
 * looks like a secret (`secret`/`token`/`authorization`/`cookie`/`nwc`), at any nesting
 * depth, is replaced with `[REDACTED]`; string values are additionally scrubbed of NWC URIs
 * and `token=`/`secret=` query params. Exported so callers that log a request (including its
 * headers) can guarantee ordinary application secrets never leak.
 */
export function sanitizeBrowserLogEntry(
  entry: OpenReceiveBrowserLogEntry,
): OpenReceiveBrowserLogEntry {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (/secret|token|authorization|cookie|nwc/i.test(key)) {
      clean[key] = "[REDACTED]";
    } else {
      clean[key] = sanitizeBrowserLogValue(value);
    }
  }
  return clean as OpenReceiveBrowserLogEntry;
}

function sanitizeBrowserLogValue(value: unknown): unknown {
  if (typeof value === "string") return redactBrowserSecrets(value);
  if (Array.isArray(value)) return value.map(sanitizeBrowserLogValue);
  if (typeof value !== "object" || value === null) return value;

  const clean: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (/secret|token|authorization|cookie|nwc/i.test(key)) {
      clean[key] = "[REDACTED]";
    } else {
      clean[key] = sanitizeBrowserLogValue(nested);
    }
  }
  return clean;
}

function redactBrowserSecrets(value: string): string {
  return value
    .replace(/nostr\+walletconnect:\/\/[^\s"'`<>]+/g, "[REDACTED_NWC]")
    .replace(/([?&](?:_or_evt|token|secret)=)[^&\s"'`<>]+/gi, "$1[REDACTED]");
}

function normalizePaymentMethods(
  value: unknown,
): readonly OpenReceiveCheckoutPaymentMethod[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map(normalizePaymentMethod)
    .filter((method): method is OpenReceiveCheckoutPaymentMethod => method !== undefined);
}

function normalizePaymentMethod(input: unknown): OpenReceiveCheckoutPaymentMethod | undefined {
  const record = asRecord(input);
  const payInAsset = optionalString(record.pay_in_asset);
  const label = optionalString(record.label);
  const networkLabel = optionalString(record.network_label);
  // Empty provider means the asset is known but no LSC provider offered it.
  const provider = typeof record.provider === "string" ? record.provider : undefined;
  if (
    payInAsset === undefined ||
    label === undefined ||
    networkLabel === undefined ||
    provider === undefined
  ) {
    return undefined;
  }
  return {
    pay_in_asset: payInAsset,
    label,
    network_label: networkLabel,
    provider,
    available: record.available === true,
    ...(optionalString(record.unavailable_reason) === undefined
      ? {}
      : { unavailable_reason: optionalString(record.unavailable_reason) }),
    ...(optionalString(record.unavailable_message) === undefined
      ? {}
      : { unavailable_message: optionalString(record.unavailable_message) }),
    ...(optionalString(record.pay_amount) === undefined
      ? {}
      : { pay_amount: optionalString(record.pay_amount) }),
    ...(optionalString(record.minimum_pay_amount) === undefined
      ? {}
      : { minimum_pay_amount: optionalString(record.minimum_pay_amount) }),
    ...(optionalString(record.maximum_pay_amount) === undefined
      ? {}
      : { maximum_pay_amount: optionalString(record.maximum_pay_amount) }),
    ...(optionalSafeInteger(record.minimum_invoice_amount_msats) === undefined
      ? {}
      : { minimum_invoice_amount_msats: optionalSafeInteger(record.minimum_invoice_amount_msats) }),
    ...(optionalSafeInteger(record.maximum_invoice_amount_msats) === undefined
      ? {}
      : { maximum_invoice_amount_msats: optionalSafeInteger(record.maximum_invoice_amount_msats) }),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) return {};
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredString(value: unknown, fieldName: string): string {
  const text = optionalString(value);
  if (text === undefined) {
    throw new TypeError(`OpenReceive checkout response requires ${fieldName}.`);
  }
  return text;
}

function optionalSafeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && typeof value === "number" ? value : undefined;
}

function requiredSafeInteger(value: unknown, fieldName: string): number {
  const integer = optionalSafeInteger(value);
  if (integer === undefined) {
    throw new TypeError(`OpenReceive checkout response requires ${fieldName}.`);
  }
  return integer;
}
