// Everything the payer sees once a swap has started: the deposit panel and its
// refund facts, network warnings, fee breakdown, transaction details, and
// support details, plus the swap-start actions the wizard offers. React's
// counterpart is react/src/swap.ts.
import {
  type CheckoutInvoiceSnapshot,
  createSwapDisplayModel,
  escapeHtml,
  OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES,
  checkoutLabels,
  swapAssetMatchesRoute,
  type SwapDisplayModel,
  swapOptionLimitMessage,
  orClasses,
} from "@openreceive/browser/headless";
import { renderElementSwapCopyDetailHtml } from "./dom-helpers.ts";
import { renderTransactionDetailsHtml } from "./transaction-details.ts";
import type { ElementsSwapOption, ElementsWizardView } from "./views.ts";

export function renderElementSwapActionsHtml(
  routeKey: string,
  options: readonly ElementsSwapOption[],
  view: ElementsWizardView,
): string {
  // Out-of-range assets stay in the list but render as a disabled button with
  // the limit reason, instead of being hidden.
  const shown = options
    .filter((option) => option.provider.length > 0)
    .filter((option) => swapAssetMatchesRoute(routeKey, option.pay_in_asset));
  if (shown.length === 0) return "";

  return `
    <div part="swap-actions" class="${orClasses.swapActions}">
      ${shown
        .map((option) => {
          const disabled = option.available === false;
          const limitMessage = elementsSwapLimitMessage(option, view);
          const info = disabled
            ? limitMessage === undefined
              ? ""
              : `<p part="swap-warning" class="${orClasses.swapWarning}">${escapeHtml(limitMessage)}</p>`
            : option.pay_amount === undefined
              ? ""
              : `<p part="swap-estimate" class="${orClasses.swapEstimate}">Estimated ${escapeHtml(option.pay_amount)} ${escapeHtml(option.label)} to settle this checkout.</p>`;
          return `
        <div class="${orClasses.swapAction}">
        ${info}
        <button
          part="swap-start"
          class="${orClasses.swapStart}"
          ${disabled ? "" : `${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapStart}="${escapeHtml(option.pay_in_asset)}"`}
          ${disabled ? 'disabled aria-disabled="true"' : ""}
          type="button"
        >Create ${escapeHtml(option.label)} (${escapeHtml(option.network_label)}) payment address</button>
        </div>
      `;
        })
        .join("")}
    </div>
  `;
}

// Short reason for an out-of-range swap asset in the web-component surface,
// sharing the React wizard's canonical message via the browser helper.
export function elementsSwapLimitMessage(
  option: ElementsSwapOption,
  view: ElementsWizardView,
): string | undefined {
  const checkout =
    view.amountMsats === undefined
      ? undefined
      : {
          amount_msats: view.amountMsats,
          ...(view.fiat?.currency === undefined || view.fiat.value === undefined
            ? {}
            : { fiat: { currency: view.fiat.currency, value: view.fiat.value } }),
        };
  return swapOptionLimitMessage(option, checkout);
}

export function renderElementSwapPanelHtml(
  invoice: CheckoutInvoiceSnapshot,
  view: ElementsWizardView = {},
): string {
  const display = createSwapDisplayModel(invoice);
  if (display === undefined) return "";
  const backButton = `
    <button part="swap-back" class="${orClasses.swapBack}" ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapBack} type="button">Pay with Lightning instead</button>
  `;
  const supportDetails = renderElementSwapSupportDetailsHtml(display);
  const heading = `
    <div part="swap-heading" class="${orClasses.swapHeading}">
      <strong class="${orClasses.swapHeadingTitle}">${escapeHtml(display.providerStateLabel)}</strong>
      <span class="${orClasses.swapHeadingDetail}">${escapeHtml(display.providerStateDetail)}</span>
    </div>
  `;

  if (display.state === "creating") {
    return `
      <section part="swap-panel" class="${orClasses.swapPanel}">
        <div part="status" class="${orClasses.paymentStatus}">
          <span part="spinner" class="${orClasses.spinner}" aria-hidden="true"></span>
          <div class="${orClasses.paymentStatusBody}">
            <strong class="${orClasses.paymentStatusTitle}">${escapeHtml(display.providerStateLabel)}</strong>
            <p class="${orClasses.paymentStatusDetail}">${escapeHtml(display.providerStateDetail)}</p>
          </div>
        </div>
        ${backButton}
      </section>
    `;
  }

  if (display.state === "deposit") {
    const feeBreakdown = renderElementSwapFeeBreakdownHtml(display.feeBreakdown);
    const waitingStatus = `
      <div part="status" class="${orClasses.paymentStatus}">
        <span part="spinner" class="${orClasses.spinner}" aria-hidden="true"></span>
        <div class="${orClasses.paymentStatusBody}">
          <div class="${orClasses.swapWaitingTitle}">
            <strong class="${orClasses.paymentStatusTitle}">${escapeHtml(display.providerStateLabel)}</strong>
            <strong part="swap-countdown" class="${orClasses.swapCountdown}">${escapeHtml(display.countdownLabel)}</strong>
          </div>
          <p class="${orClasses.paymentStatusDetail}">${escapeHtml(display.providerStateDetail)}</p>
        </div>
      </div>
    `;
    return `
      <section part="swap-panel" class="${orClasses.swapPanel}">
        <p part="swap-instruction" class="${orClasses.swapInstruction}">Pay <strong>${escapeHtml(display.depositAmount)} ${escapeHtml(display.assetLabel)}</strong> to this address</p>
        ${renderElementSwapNetworkWarningHtml(display)}
        <div part="swap-deposit-layout" class="${orClasses.swapDepositLayout}">
          <div part="swap-qr" class="${orClasses.swapQr}" ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapQr}="${escapeHtml(display.qrPayload)}"></div>
          <div part="swap-deposit-side" class="${orClasses.swapDepositSide}">
            <dl part="swap-details" class="${orClasses.swapDetails}">
              ${renderElementSwapCopyDetailHtml("Address", display.depositAddress)}
              ${display.depositMemo === undefined ? "" : renderElementSwapCopyDetailHtml("Memo", display.depositMemo)}
              ${renderElementSwapCopyDetailHtml("Amount", display.depositAmount)}
            </dl>
            ${waitingStatus}
            ${feeBreakdown}
          </div>
        </div>
        ${backButton}
      </section>
    `;
  }

  if (display.state === "settled") {
    return `
      <section part="swap-panel" class="${orClasses.swapPanel}">
        ${heading}
        <dl part="swap-details" class="${orClasses.swapDetails}">
          ${display.depositTxId === undefined ? "" : renderElementSwapCopyDetailHtml("Deposit transaction", display.depositTxId, display.depositTxId, display.payInAsset)}
          ${display.payoutTxId === undefined ? "" : renderElementSwapCopyDetailHtml("Lightning payout", display.payoutTxId)}
          ${display.providerOrderId === undefined ? "" : renderElementSwapCopyDetailHtml("Provider order", display.providerOrderId)}
        </dl>
        ${renderElementTransactionDetailsHtml(invoice, view)}
      </section>
    `;
  }

  if (display.state === "progress") {
    return `
      <section part="swap-panel" class="${orClasses.swapPanel}">
        <div part="status" class="${orClasses.paymentStatus}">
          <span part="spinner" class="${orClasses.spinner}" aria-hidden="true"></span>
          <div class="${orClasses.paymentStatusBody}">
            <strong class="${orClasses.paymentStatusTitle}">${escapeHtml(display.providerStateLabel)}</strong>
            <p class="${orClasses.paymentStatusDetail}">${escapeHtml(display.providerStateDetail)}</p>
          </div>
        </div>
        ${supportDetails}
      </section>
    `;
  }

  if (display.state === "expired") {
    return `
      <section part="swap-panel" class="${orClasses.swapPanel}">
        ${heading}
        <p part="swap-warning" class="${orClasses.swapWarning}">This payment address expired without a detected payment. Create a new payment address to try again.</p>
        ${supportDetails}
        ${backButton}
      </section>
    `;
  }

  if (display.state === "refund_required") {
    const stagedRefundAddress = display.refundAddress;
    const refundFacts = renderElementSwapRefundFactsHtml(display);
    return `
      <section part="swap-panel" class="${orClasses.swapPanel}">
        ${heading}
        ${refundFacts}
        <p part="swap-warning" class="${orClasses.swapWarning}">Use a ${escapeHtml(display.networkLabel)} address you control. Do not paste the deposit address.</p>
        ${
          stagedRefundAddress === undefined
            ? `
          <form
            part="swap-refund"
            class="${orClasses.swapRefund}"
            novalidate
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapRefundForm}="${escapeHtml(display.attemptId)}"
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapRefundPayInAsset}="${escapeHtml(display.payInAsset)}"
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapRefundNetworkLabel}="${escapeHtml(display.networkLabel)}"
            ${display.refundNonce === undefined ? "" : `${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapRefundNonce}="${escapeHtml(display.refundNonce)}"`}
          >
            <input
              class="${orClasses.swapRefundInput}"
              ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapRefundAddress}
              name="refund_address"
              placeholder="${escapeHtml(display.networkLabel)} refund address"
              type="text"
              autocomplete="off"
              required
            >
            <p
              part="swap-refund-error"
              class="${orClasses.swapRefundError}"
              ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapRefundError}
              hidden
              role="alert"
            ></p>
            <p part="swap-refund-hint" class="${orClasses.swapRefundHint}">Make sure you control this ${escapeHtml(display.networkLabel)} address. Refunds sent to the wrong address usually cannot be recovered.</p>
            <button class="${orClasses.btn}" type="submit">Review refund address</button>
          </form>
        `
            : `
          <form
            part="swap-refund"
            class="${orClasses.swapRefund}"
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapRefundForm}="${escapeHtml(display.attemptId)}"
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapRefundPayInAsset}="${escapeHtml(display.payInAsset)}"
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapRefundNetworkLabel}="${escapeHtml(display.networkLabel)}"
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapRefundConfirm}="true"
            ${display.refundNonce === undefined ? "" : `${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapRefundNonce}="${escapeHtml(display.refundNonce)}"`}
          >
            <p part="swap-warning" class="${orClasses.swapWarning}">Confirm refund to ${escapeHtml(stagedRefundAddress)}.</p>
            <input
              ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapRefundAddress}
              name="refund_address"
              type="hidden"
              value="${escapeHtml(stagedRefundAddress)}"
            >
            <button class="${orClasses.btn}" type="submit">Confirm refund</button>
          </form>
        `
        }
        ${supportDetails}
        ${renderElementSwapRefundReturnWarningHtml()}
      </section>
    `;
  }

  if (display.state === "refund_pending" || display.state === "refunded") {
    const refundFacts = renderElementSwapRefundFactsHtml(display);
    return `
      <section part="swap-panel" class="${orClasses.swapPanel}">
        ${heading}
        ${refundFacts}
        <dl part="swap-details" class="${orClasses.swapDetails}">
          ${display.refundAddress === undefined ? "" : renderElementSwapCopyDetailHtml("Refund address", display.refundAddress, display.refundAddress, display.payInAsset)}
          ${display.refundTxId === undefined ? "" : renderElementSwapCopyDetailHtml("Refund transaction", display.refundTxId, display.refundTxId, display.payInAsset)}
        </dl>
        ${supportDetails}
        ${renderElementSwapRefundReturnWarningHtml()}
      </section>
    `;
  }

  return `
    <section part="swap-panel" class="${orClasses.swapPanel}">
      ${heading}
      <p part="swap-warning" class="${orClasses.swapWarning}">This payment needs support review.</p>
      ${supportDetails}
      ${backButton}
    </section>
  `;
}

function renderElementSwapRefundReturnWarningHtml(): string {
  return `
    <p part="swap-refund-return" class="${orClasses.swapWarning}">${escapeHtml(checkoutLabels.refundReturnWarning)}</p>
  `;
}

function renderElementSwapRefundFactsHtml(display: SwapDisplayModel): string {
  const rows = [
    display.depositReceivedAmount === undefined
      ? ""
      : renderElementSwapCopyDetailHtml(
          "Amount received",
          `${display.depositReceivedAmount} ${display.assetLabel}`,
        ),
    display.depositReceivedAmount === undefined
      ? ""
      : renderElementSwapCopyDetailHtml(
          "Amount required",
          `${display.depositAmount} ${display.assetLabel}`,
        ),
    display.refundAmount === undefined
      ? ""
      : renderElementSwapCopyDetailHtml(
          "Estimated refund",
          `${display.refundAmount} ${display.assetLabel}`,
        ),
  ].join("");
  if (rows.length === 0) return "";
  return `<dl part="swap-details" class="${orClasses.swapDetails}">${rows}</dl>`;
}

function renderElementSwapNetworkWarningHtml(
  display: Pick<
    NonNullable<ReturnType<typeof createSwapDisplayModel>>,
    "networkWarningTitle" | "networkWarningEmphasis" | "networkWarning"
  >,
): string {
  const emphasisStart = display.networkWarning.indexOf(display.networkWarningEmphasis);
  const before =
    emphasisStart === -1
      ? escapeHtml(display.networkWarning)
      : escapeHtml(display.networkWarning.slice(0, emphasisStart));
  const after =
    emphasisStart === -1
      ? ""
      : escapeHtml(
          display.networkWarning.slice(emphasisStart + display.networkWarningEmphasis.length),
        );
  const emphasis =
    emphasisStart === -1
      ? ""
      : `<strong class="${orClasses.swapNetworkWarningEmphasis}">${escapeHtml(display.networkWarningEmphasis)}</strong>`;
  return `
    <div part="swap-network-warning" role="alert" class="${orClasses.swapNetworkWarning}">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="${orClasses.swapNetworkWarningIcon}" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
      </svg>
      <div class="${orClasses.swapNetworkWarningContent}">
        <p class="${orClasses.swapNetworkWarningTitle}">${escapeHtml(display.networkWarningTitle)}</p>
        <p class="${orClasses.swapNetworkWarningBody}">${before}${emphasis}${after}</p>
      </div>
    </div>
  `;
}

function renderElementTransactionDetailsHtml(
  invoice: CheckoutInvoiceSnapshot,
  view: ElementsWizardView,
): string {
  const bolt11 = typeof invoice.invoice === "string" ? invoice.invoice : view.lightningInvoice;
  return renderTransactionDetailsHtml({
    ...(view.orderId === undefined ? {} : { order_id: view.orderId }),
    ...(view.checkoutId === undefined ? {} : { checkout_id: view.checkoutId }),
    invoice_id: invoice.invoice_id,
    ...(bolt11 === undefined ? {} : { invoice: bolt11 }),
    rail: invoice.rail,
    ...(invoice.payment_hash === undefined
      ? view.paymentHash === undefined
        ? {}
        : { payment_hash: view.paymentHash }
      : { payment_hash: invoice.payment_hash }),
    ...(invoice.amount_msats === undefined
      ? view.amountMsats === undefined
        ? {}
        : { amount_msats: view.amountMsats }
      : { amount_msats: invoice.amount_msats }),
    ...(invoice.fiat_quote === undefined
      ? view.fiat?.currency === undefined || view.fiat.value === undefined
        ? {}
        : { fiat_quote: { fiat: { currency: view.fiat.currency, value: view.fiat.value } } }
      : { fiat_quote: invoice.fiat_quote }),
    ...(invoice.transaction_state === undefined
      ? {}
      : { transaction_state: invoice.transaction_state }),
    ...(invoice.workflow_state === undefined ? {} : { workflow_state: invoice.workflow_state }),
    ...(invoice.expires_at === undefined ? {} : { expires_at: invoice.expires_at }),
    ...(invoice.settled_at === undefined ? {} : { settled_at: invoice.settled_at }),
    ...(invoice.swap === undefined ? {} : { swap: invoice.swap }),
  });
}

function renderElementSwapFeeBreakdownHtml(
  breakdown: NonNullable<ReturnType<typeof createSwapDisplayModel>>["feeBreakdown"],
): string {
  if (breakdown === undefined) return "";
  const feeValue =
    breakdown.feePercent === undefined
      ? breakdown.fee
      : `${breakdown.fee} (${breakdown.feePercent})`;
  return `
    <div part="swap-breakdown" class="${orClasses.swapBreakdown}">
      <p part="swap-breakdown-title" class="${orClasses.swapBreakdownTitle}">Payment breakdown</p>
      <dl part="swap-details" class="${orClasses.swapBreakdownRows}">
        <dt>Cart total</dt>
        <dd>${escapeHtml(breakdown.cartTotal)}</dd>
        <dt>You send</dt>
        <dd>${escapeHtml(breakdown.youSend)}</dd>
        <dt>Swap + network fees</dt>
        <dd>${escapeHtml(feeValue)}</dd>
      </dl>
    </div>
  `;
}

function renderElementSwapSupportDetailsHtml(
  display: NonNullable<ReturnType<typeof createSwapDisplayModel>>,
): string {
  if (
    display.depositTxId === undefined &&
    display.payoutTxId === undefined &&
    display.refundTxId === undefined &&
    display.providerOrderId === undefined
  ) {
    return "";
  }
  return `
    <details part="swap-support" class="${orClasses.swapSupport}">
      <summary class="${orClasses.swapSupportTitle}">Payment details</summary>
      <div class="${orClasses.swapSupportContent}">
        <dl part="swap-details" class="${orClasses.swapDetails}">
          ${display.depositTxId === undefined ? "" : renderElementSwapCopyDetailHtml("Deposit transaction", display.depositTxId, display.depositTxId, display.payInAsset)}
          ${display.payoutTxId === undefined ? "" : renderElementSwapCopyDetailHtml("Lightning payout", display.payoutTxId)}
          ${display.refundTxId === undefined ? "" : renderElementSwapCopyDetailHtml("Refund transaction", display.refundTxId, display.refundTxId, display.payInAsset)}
          ${display.providerOrderId === undefined ? "" : renderElementSwapCopyDetailHtml("Provider order", display.providerOrderId)}
        </dl>
      </div>
    </details>
  `;
}
