// The swap attempt as the payer sees it: the fee breakdown, the deposit-panel
// display model, the refund staging overlay, provider-state labels and
// details, and the asset/route matching the wizard selection needs.

import {
  type Decimal,
  formatDecimal,
  parseDecimal,
  payInAssetNetwork,
  swapAddressNetworkForPayInAsset,
} from "@openreceive/core";
import {
  formatCountdown,
  formatDepositAmount,
  formatFiatAmount,
  rescaleHalfUp,
  roundedDiv,
} from "./checkout-format.ts";
import {
  type CheckoutInvoiceSnapshot,
  type CheckoutInvoiceSwapFee,
  type CheckoutSnapshot,
  checkoutLabels,
  type SwapDepositRisk,
  type SwapDisplayModel,
  type SwapFeeBreakdown,
} from "./ui.ts";
import { resolveNow, type UnixSeconds } from "./unix-seconds.ts";

/**
 * Turn the provider's fiat equivalents into a display-ready fee breakout. The payer
 * sends crypto worth `pay_in_fiat`; the merchant receives `payout_fiat` (the cart
 * total). The difference is the swap fee (exchange spread + network fees). Returns
 * undefined when the figures are missing or not sensible so callers can hide the row.
 */
export function createSwapFeeBreakdown(
  fee: CheckoutInvoiceSwapFee | undefined,
): SwapFeeBreakdown | undefined {
  if (fee === undefined) return undefined;
  // Exact decimal math on the shared money engine — never binary floats, even
  // for display-only fiat values.
  // Hiding the fee row on an unreadable figure is a PRODUCT choice — a
  // breakdown that cannot be computed is worse than no breakdown — so the
  // parse is caught here, at the row boundary, and nowhere else.
  let payIn: Decimal;
  let payout: Decimal;
  try {
    payIn = parseDecimal(fee.pay_in_fiat);
    payout = parseDecimal(fee.payout_fiat);
  } catch {
    return undefined;
  }
  // Distinct from the parse above: this one guards our own division below.
  if (payout.units <= 0n) return undefined;
  // Align to one scale, subtract exactly.
  const scale = Math.max(payIn.scale, payout.scale);
  const payInUnits = payIn.units * 10n ** BigInt(scale - payIn.scale);
  const payoutUnits = payout.units * 10n ** BigInt(scale - payout.scale);
  const feeUnits = payInUnits > payoutUnits ? payInUnits - payoutUnits : 0n;
  const format = (units: bigint): string => {
    const value = formatDecimal(rescaleHalfUp(units, scale, 2), 2);
    return formatFiatAmount({ currency: fee.currency, value }) ?? `${value} ${fee.currency}`;
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
 * Which of the two ways a deposit is lost is reachable on this rail — the input
 * to how loud the deposit panel is. See {@link SwapDepositRisk} for the
 * vocabulary and why native-vs-token is NOT the axis.
 *
 * Derived, never tabulated. A hand-kept rail list goes stale the day a rail is
 * added, and it would go stale in the unsafe direction: a new rail would
 * inherit whatever the last edit happened to leave. The two questions are asked
 * of the pay-in code itself, so an unclassifiable one falls through to the full
 * alarm.
 *
 * 1. Does the address FORMAT pin the chain? Only for networks
 *    `swapAddressNetworkForPayInAsset` can name a checksum rule for, minus ETH:
 *    a `0x…` address is byte-identical on every EVM chain. An unrecognized
 *    network answers no.
 * 2. Is the asset that chain's NATIVE coin? `SOL_SOL` yes, `USDT_TRON` no.
 *    Compared against the normalized network so the `TRON`/`TRX` spelling split
 *    cannot make native TRX look like a token.
 */
export function swapDepositRisk(payInAsset: string): SwapDepositRisk {
  const network = swapAddressNetworkForPayInAsset(payInAsset);
  // ETH is named because its address format is the ambiguity: every EVM chain
  // accepts the same `0x…` string. `undefined` is every network we have no
  // format rule for at all.
  if (network === undefined || network === "ETH") return "chain_ambiguous";
  // Is the asset this chain's NATIVE coin? `SOL_SOL` yes, `USDT_TRON` no. Ask
  // core the same question about a code built from the symbol alone, so the
  // `TRON` suffix / `TRX` symbol spelling split resolves through core's one
  // network table rather than a second copy of it here.
  const symbol = payInAsset.slice(0, payInAsset.lastIndexOf("_"));
  return swapAddressNetworkForPayInAsset(`${symbol}_${symbol}`) === network
    ? "pinned"
    : "asset_only";
}

/**
 * @param options.now Unix timestamp in **seconds** ({@link UnixSeconds}); the
 *   provider countdown is measured against it. Milliseconds (`Date.now()`)
 *   throw rather than pinning every deposit window at zero.
 * @param options.resumable Whether this checkout has a URL the payer can come
 *   BACK to — a synced history path, or the host's own per-order route. It
 *   decides {@link SwapDisplayModel.refundReturnLabel} and nothing else; the
 *   refund form itself stays available either way, because a payer who is on
 *   the screen right now can still submit one. Defaults to `false`: a host that
 *   has not said it is resumable is the host whose payer must not be told to
 *   bookmark the page.
 */
export function createSwapDisplayModel(
  invoice: CheckoutInvoiceSnapshot,
  options: { readonly now?: UnixSeconds; readonly resumable?: boolean } = {},
): SwapDisplayModel | undefined {
  const swap = invoice.swap;
  if (swap === undefined) return undefined;
  const expiresAt = Math.min(
    swap.provider_expires_at,
    invoice.expires_at ?? swap.provider_expires_at,
  );
  const expiresInSeconds = Math.max(0, expiresAt - resolveNow(options.now));
  const asset = getSwapAssetDisplay(swap.pay_in_asset);
  const depositAmount = formatDepositAmount(swap.deposit_amount);
  const networkWarningEmphasis = `${depositAmount} ${asset.assetLabel} on the ${asset.networkLabel} network`;
  const depositRisk = swapDepositRisk(swap.pay_in_asset);
  // The lost-funds half is claimed only where it is reachable. The
  // "one method only" half is on every rail: double-paying does not care what
  // the address format pins.
  const doubleSpendWarning = `Pay with one method only — if you already sent ${asset.assetLabel}, do not also pay the Lightning invoice.`;
  // Settlement authority is OpenReceive's own wallet sweep, surfaced as the shadow
  // invoice's settled transaction_state — never the provider's `completed` state (see
  // OPENRECEIVE_SWAP_STATES). Once the order is paid the panel shows a final
  // confirmation, even if `provider_state` still lags on "confirming"/"exchanging".
  const settled = invoice.transaction_state === "settled";
  const feeBreakdown = createSwapFeeBreakdown(swap.fee);

  return {
    provider: swap.provider,
    attemptId: swap.attempt_id ?? invoice.invoice_id,
    payInAsset: swap.pay_in_asset,
    assetLabel: asset.assetLabel,
    networkLabel: asset.networkLabel,
    depositRisk,
    networkWarningTitle:
      depositRisk === "pinned"
        ? checkoutLabels.sendExactAmountTitle
        : checkoutLabels.wrongCurrencyOrNetworkTitle,
    networkWarningEmphasis,
    networkWarning:
      depositRisk === "pinned"
        ? `Send exactly ${networkWarningEmphasis}. ${doubleSpendWarning}`
        : `Be sure you are sending exactly ${networkWarningEmphasis}. If you send the wrong currency or send on the wrong network, your funds will be lost! ${doubleSpendWarning}`,
    depositAddress: swap.deposit_address,
    ...(swap.deposit_memo === undefined ? {} : { depositMemo: swap.deposit_memo }),
    depositAmount,
    copyRows: [
      // Selectable, not just copyable: a payer on a phone that blocks the
      // clipboard API still has to be able to select the string by hand.
      {
        label: checkoutLabels.swapCopyAddress,
        value: swap.deposit_address,
        selectable: true,
      },
      // Present only on the rails that require one, and a deposit that arrives
      // WITHOUT it can be unrecoverable at the provider — worse than an
      // underpayment, because there is no `refund_required` to act on. It is a
      // labelled row like the others, never prose inside a warning banner.
      ...(swap.deposit_memo === undefined
        ? []
        : [
            {
              label: checkoutLabels.swapCopyMemo,
              value: swap.deposit_memo,
              selectable: false,
            },
          ]),
      { label: checkoutLabels.swapCopyAmount, value: depositAmount, selectable: true },
    ],
    providerStateLabel: settled
      ? "Payment complete"
      : getSwapProviderStateLabel(swap.provider_state),
    providerStateDetail: settled
      ? "Your payment is confirmed and your order is complete."
      : getSwapProviderStateDetail(swap.provider_state, swap.pay_in_asset, {
          refundReason: swap.refund_reason,
          depositAmount: swap.deposit_amount,
          depositReceivedAmount: swap.deposit_received_amount,
          refundAmount: swap.refund_amount,
        }),
    state: settled ? "settled" : getSwapPanelState(swap.provider_state),
    expiresInSeconds,
    countdownLabel: formatCountdown(expiresInSeconds),
    qrPayload: createSwapQrPayload(swap),
    ...(feeBreakdown === undefined ? {} : { feeBreakdown }),
    ...(swap.deposit_tx_id === undefined ? {} : { depositTxId: swap.deposit_tx_id }),
    ...(swap.payout_tx_id === undefined ? {} : { payoutTxId: swap.payout_tx_id }),
    ...(swap.refund_address === undefined ? {} : { refundAddress: swap.refund_address }),
    refundAllowed: swap.provider_state === "refund_required",
    resumable: options.resumable === true,
    refundReturnLabel:
      options.resumable === true
        ? checkoutLabels.refundReturnWarning
        : checkoutLabels.refundNoReturnWarning,
    ...(swap.refund_tx_id === undefined ? {} : { refundTxId: swap.refund_tx_id }),
    ...(swap.refund_reason === undefined ? {} : { refundReason: swap.refund_reason }),
    ...(swap.deposit_received_amount === undefined
      ? {}
      : {
          depositReceivedAmount: formatDepositAmount(swap.deposit_received_amount),
        }),
    ...(swap.refund_amount === undefined
      ? {}
      : { refundAmount: formatDepositAmount(swap.refund_amount) }),
    ...(swap.provider_order_id === undefined ? {} : { providerOrderId: swap.provider_order_id }),
  };
}

/**
 * Package-private. Poll snapshots omit the locally staged refund address, so it
 * is overlaid back on before anything reads them. This is not a rule an
 * integration has to remember: {@link CheckoutWatcher} holds the staged invoice
 * and folds it through {@link overlaySwapRefundStagingIntoSnapshot} on every
 * snapshot it publishes, and {@link selectCurrentSwapInvoice} is the same fold
 * for a renderer that carries its own started attempt.
 */
export function overlaySwapRefundStaging(
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
  // The staged refund ADDRESS is the review marker: it is present locally after
  // the payer reviews and absent from the server's view until they confirm.
  const refund_address = invoiceSwap.refund_address ?? localSwap.refund_address;
  if (refund_address === invoiceSwap.refund_address) return invoice;
  return {
    ...invoice,
    swap: {
      ...invoiceSwap,
      ...(refund_address === undefined ? {} : { refund_address }),
    },
  };
}

/**
 * The same overlay across a whole snapshot: every invoice, plus `active`. The
 * watcher applies this before `onSnapshot` and before `createCheckoutState`, so
 * a host that stores what it is handed keeps the address the payer is reviewing
 * without knowing this function exists.
 */
export function overlaySwapRefundStagingIntoSnapshot(
  snapshot: CheckoutSnapshot,
  staged: CheckoutInvoiceSnapshot | undefined | null,
): CheckoutSnapshot {
  if (staged?.swap?.refund_address === undefined) return snapshot;
  const invoices = snapshot.invoices.map((invoice) => overlaySwapRefundStaging(invoice, staged));
  const changed = invoices.some((invoice, index) => invoice !== snapshot.invoices[index]);
  const active =
    snapshot.active === undefined ? undefined : overlaySwapRefundStaging(snapshot.active, staged);
  if (!changed && active === snapshot.active) return snapshot;
  return {
    ...snapshot,
    invoices,
    ...(active === undefined ? {} : { active }),
  };
}

/**
 * The current swap attempt as a renderer should read it: the polled snapshot's
 * copy when it has one, the locally started attempt when the snapshot has not
 * caught up, and the staged refund address folded over either. Both shipped
 * renderers used to keep a near-identical copy of this; a headless UI holding
 * its own snapshot store wants the same three rules.
 *
 * `dismissedInvoiceId` is the "back to Lightning" exit: a dismissed attempt is
 * invisible until a new start or a refund clears the dismissal.
 */
export function selectCurrentSwapInvoice(
  snapshot: CheckoutSnapshot | undefined,
  options: {
    readonly started?: CheckoutInvoiceSnapshot | null;
    readonly dismissedInvoiceId?: string | null;
  } = {},
): CheckoutInvoiceSnapshot | undefined {
  const dismissedInvoiceId = options.dismissedInvoiceId ?? null;
  const started = options.started ?? null;
  const fromSnapshot = snapshot?.invoices.find(
    (invoice) =>
      invoice.rail === "swap" &&
      invoice.swap !== undefined &&
      invoice.invoice_id !== dismissedInvoiceId,
  );
  if (started === null || started.invoice_id === dismissedInvoiceId) return fromSnapshot;
  const matched =
    snapshot?.invoices.find((invoice) => invoice.invoice_id === started.invoice_id) ?? started;
  return overlaySwapRefundStaging(matched, started);
}

export function swapAssetMatchesRoute(routeKey: string, payInAsset: string | undefined): boolean {
  if (payInAsset === undefined) return false;
  const route = routeKey.includes(":") ? (routeKey.split(":").at(-1) ?? routeKey) : routeKey;
  if (route === "usdt") return payInAsset.startsWith("USDT_");
  if (route === "usdc") return payInAsset.startsWith("USDC_");
  if (route === "eth") return payInAsset === "ETH_ETH";
  if (route === "sol") return payInAsset === "SOL_SOL";
  return false;
}

export function getSwapProviderStateLabel(state: string): string {
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

function getSwapProviderStateDetail(
  state: string,
  payInAsset: string,
  refundContext: {
    readonly refundReason?: string;
    readonly depositAmount?: string;
    readonly depositReceivedAmount?: string;
    readonly refundAmount?: string;
  } = {},
): string {
  const { networkLabel, assetLabel } = getSwapAssetDisplay(payInAsset);
  if (state === "creating_provider_order") return "Creating a payment address.";
  if (state === "awaiting_deposit") return "Send exactly the amount shown below.";
  if (state === "confirming") {
    return `Your payment was detected on ${networkLabel}. ${getSwapConfirmationWaitHint(payInAsset)}`;
  }
  if (state === "exchanging") {
    return "Your payment is confirmed and being converted. This usually finishes within a minute.";
  }
  if (state === "paying_invoice" || state === "completed") {
    return "The provider is sending the Lightning payment. This usually takes a few seconds.";
  }
  if (state === "expired") return "No payment was received before the payment window closed.";
  if (state === "refund_required" || state === "refund_pending" || state === "refunded") {
    return getSwapRefundDetail(state, assetLabel, refundContext);
  }
  if (state === "attention") return checkoutLabels.supportReviewNeeded;
  if (state === "failed") return "This payment address can no longer be used.";
  return state;
}

function getSwapRefundDetail(
  state: string,
  assetLabel: string,
  refundContext: {
    readonly refundReason?: string;
    readonly depositAmount?: string;
    readonly depositReceivedAmount?: string;
    readonly refundAmount?: string;
  },
): string {
  const reasonDetail = getSwapRefundReasonDetail(refundContext, assetLabel);
  const refundAmountDetail =
    refundContext.refundAmount === undefined
      ? undefined
      : `Estimated refund: ${formatDepositAmount(refundContext.refundAmount)} ${assetLabel} before network fees.`;

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

function getSwapRefundReasonDetail(
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
      : formatDepositAmount(refundContext.depositAmount);
  const received =
    refundContext.depositReceivedAmount === undefined
      ? undefined
      : formatDepositAmount(refundContext.depositReceivedAmount);

  if (refundContext.refundReason === "underpaid") {
    if (expected !== undefined && received !== undefined) {
      return `You sent ${received} ${assetLabel} but ${expected} ${assetLabel} was required.`;
    }
    return "The amount received was less than required.";
  }
  if (refundContext.refundReason === "overpaid") {
    if (expected !== undefined && received !== undefined) {
      return `You sent ${received} ${assetLabel} but ${expected} ${assetLabel} was required.`;
    }
    return "The amount received was more than required.";
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
  if (refundContext.refundReason === "overpaid_and_late") {
    if (expected !== undefined && received !== undefined) {
      return `You sent ${received} ${assetLabel} but ${expected} ${assetLabel} was required, and it arrived after the payment window closed.`;
    }
    return "Your payment was over the required amount and arrived after the window closed.";
  }
  return undefined;
}

/**
 * Rough payer-facing confirmation guidance by deposit network. Not a SLA —
 * chain congestion and provider policy can take longer.
 */
export function getSwapConfirmationWaitHint(payInAsset: string): string {
  const network = payInAssetNetwork(payInAsset);
  if (network === "TRON") return "Confirmation usually takes 1–3 minutes.";
  if (network === "SOL") return "Confirmation usually takes under a minute.";
  if (network === "ETH") return "Confirmation often takes 5–15 minutes.";
  return "Confirmation usually takes a few minutes.";
}

function getSwapPanelState(state: string): SwapDisplayModel["state"] {
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

export function getSwapAssetDisplay(payInAsset: string): {
  readonly assetLabel: string;
  readonly networkLabel: string;
} {
  const network = payInAssetNetwork(payInAsset);
  const networkLabel =
    network === "TRON"
      ? "Tron"
      : network === "SOL"
        ? "Solana"
        : network === "ETH"
          ? "Ethereum"
          : (network ?? payInAsset);
  return {
    assetLabel: payInAsset.split("_")[0] ?? payInAsset,
    networkLabel,
  };
}

/**
 * The QR the payer scans for a swap deposit.
 *
 * AMOUNT-PREFILL POLICY: only the NATIVE-COIN rails carry an amount
 * (`ethereum:…?value=`, `solana:…?amount=`). Token rails (USDT_TRON, USDT_ETH,
 * USDC_ETH, …) deliberately encode the bare deposit address: the EIP-681
 * token-transfer form is parsed inconsistently across wallets, and a wallet
 * that mis-parses it shows a broken request rather than no prefill. For those
 * rails the panel's "send exactly X" is the amount of record.
 *
 * The one thing this never does is silently drop a prefill it was supposed to
 * emit: a deposit_amount from our own server that will not convert throws, and
 * the panel's error surface shows it. An amount-LESS payment URI is the worst
 * outcome of the three, because the wallet then lets the payer type any amount.
 */
function createSwapQrPayload(swap: NonNullable<CheckoutInvoiceSnapshot["swap"]>): string {
  if (swap.pay_in_asset === "ETH_ETH") {
    const wei = decimalAmountToIntegerString(swap.deposit_amount, 18);
    return `ethereum:${swap.deposit_address}?value=${wei}`;
  }
  if (swap.pay_in_asset === "SOL_SOL") {
    const amount = formatDepositAmount(swap.deposit_amount);
    return `solana:${swap.deposit_address}?amount=${encodeURIComponent(amount)}`;
  }
  return swap.deposit_address;
}

function decimalAmountToIntegerString(amount: string, decimals: number): string {
  const parsed = parseDecimal(amount);
  if (parsed.scale > decimals) {
    throw new RangeError(`deposit_amount is more precise than ${decimals} decimals: ${amount}`);
  }
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
