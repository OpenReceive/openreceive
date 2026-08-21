import {
  type CheckoutState,
  createCheckoutDisplayModel,
  createCheckoutStatusModel,
  createOpenReceiveLightningInvoiceDecodeUrl,
  createOpenReceivePaymentDataEntries,
  status as deriveStatus,
  escapeOpenReceiveHtml as escapeHtml,
  formatOpenReceiveAmountCaption,
  OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES,
  OPENRECEIVE_CHECKOUT_ELEMENT_PARTS,
  OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_PARTS,
  type OpenReceivePaymentDataSource,
  openReceiveCheckoutLabels,
  orClasses,
} from "@openreceive/browser/internal";

import { COPY_INVOICE_ICON } from "./dom-helpers.ts";

import { openReceiveCheckoutStyleTag } from "./element-styles.ts";

import { renderOpenReceivePaymentWizardHtml } from "./render-wizard.ts";

import { type CheckoutView, createElementCheckoutState } from "./views.ts";

export function renderCheckoutHtml(view: CheckoutView): string {
  const display = createCheckoutDisplayModel({
    ...view,
    rail: view.rail ?? "lightning",
  });
  const checkoutState = view.liveState ?? createElementCheckoutState(view);
  const amountCaption = formatOpenReceiveAmountCaption({
    amountLabel: display.amountLabel,
    fiatLabel: display.fiatLabel,
    fiatCurrency: display.fiat_quote?.fiat?.currency,
  });
  const satsDetail =
    amountCaption === undefined
      ? ""
      : `<div part="sats-detail" class="${orClasses.satsDetail}">${escapeHtml(amountCaption)}</div>`;
  const statusLabel =
    view.status ?? (checkoutState === undefined ? deriveStatus(view) : deriveStatus(checkoutState));
  // Amount/fiat already appear under the QR; pending is covered by WaitingState.
  const showSummaryMeta = statusLabel === "settled" || statusLabel === "expired";
  const stateClass = statusLabel === "settled" ? orClasses.stateSettled : orClasses.statePending;
  const stateLabel = showSummaryMeta
    ? `<span part="state" class="${stateClass}" data-state="${escapeHtml(statusLabel)}">${escapeHtml(statusLabel)}</span>`
    : "";
  const status = checkoutState === undefined ? "" : renderElementPaymentStatusHtml(checkoutState);
  const statusModel =
    checkoutState === undefined ? undefined : createCheckoutStatusModel(checkoutState);
  const expired = statusModel?.phase === "expired";
  const settled = statusLabel === "settled";
  // Settled always shows the payment layout: after a swap deposit settles, the
  // selected swap asset would otherwise keep hiding it and blank the whole widget.
  const hideLightning =
    !settled &&
    (view.lightningRequested === false ||
      ((view.wizard?.selectedSwapAsset ?? null) !== null && !expired));
  const wizard =
    expired || settled || view.payment_wizard === false
      ? ""
      : renderOpenReceivePaymentWizardHtml(view.wizard);
  const copyButton = `<button part="${OPENRECEIVE_CHECKOUT_ELEMENT_PARTS.copy}" class="${orClasses.btn}" type="button">${COPY_INVOICE_ICON}<span ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapCopyLabel}>${escapeHtml(openReceiveCheckoutLabels.copyInvoice)}</span></button>`;
  const decodeInvoice =
    view.invoice.trim() !== ""
      ? view.invoice
      : typeof view.wizard?.lightningInvoice === "string" &&
          view.wizard.lightningInvoice.trim() !== ""
        ? view.wizard.lightningInvoice
        : undefined;
  const decodeHref =
    decodeInvoice === undefined
      ? undefined
      : createOpenReceiveLightningInvoiceDecodeUrl(decodeInvoice, view.decodeLinkUrl);
  const decodeButton =
    decodeHref === undefined
      ? ""
      : `<a part="decode-invoice" class="${orClasses.btn}" href="${escapeHtml(decodeHref)}" rel="noreferrer" target="_blank">${escapeHtml(openReceiveCheckoutLabels.decodeInvoice)}</a>`;
  const startOverButton = `<button part="${OPENRECEIVE_CHECKOUT_ELEMENT_PARTS.startOver}" class="${orClasses.btn}" type="button">${escapeHtml(openReceiveCheckoutLabels.startOver)}</button>`;
  // Settled: the QR / copy / decode affordances are for paying, so they drop out and a
  // payment-data panel takes their place next to the green "Payment received" status.
  const lightningPane =
    hideLightning || expired || settled
      ? ""
      : `<div part="lightning-pane" class="${orClasses.lightningPane}">
          <div part="qr" class="${orClasses.qr}" ${OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.qr}></div>
          ${satsDetail}
        </div>`;
  const paymentLayoutClass =
    expired || settled ? orClasses.paymentLayoutExpired : orClasses.paymentLayout;
  const metaRow =
    stateLabel === "" ? "" : `<div part="meta" class="${orClasses.meta}">${stateLabel}</div>`;
  const invoiceTitle =
    expired || settled
      ? ""
      : `<p part="invoice-title" class="${orClasses.invoiceTitle}">${escapeHtml(openReceiveCheckoutLabels.bitcoinLightningInvoice)}</p>`;
  const actions = settled
    ? renderElementPaymentDataHtml(checkoutState ?? display)
    : expired
      ? `<div part="actions" class="${orClasses.actions}">${startOverButton}</div>`
      : `<div part="actions" class="${orClasses.actions}">${copyButton}${decodeButton}</div>`;

  const resolvedTheme = view.theme ?? "light";
  return `
    ${styleTag(view.inlineStyles)}
    <section part="root" data-theme="${escapeHtml(resolvedTheme)}" class="${orClasses.root}">
      ${
        hideLightning
          ? ""
          : `<div part="payment-layout" class="${paymentLayoutClass}">
            ${lightningPane}
            <div part="payment-info" class="${orClasses.paymentInfo}">
              ${invoiceTitle}
              ${status}
              ${metaRow}
              ${actions}
            </div>
          </div>`
      }
      ${wizard}
    </section>
  `;
}

/**
 * `false` when the caller adopts the compiled stylesheet into the shadow root
 * instead (see element-styles.ts); the markup then carries no `<style>`.
 */
export interface RenderOpenReceiveStyleOptions {
  readonly inlineStyles?: boolean;
}

function styleTag(inlineStyles: boolean | undefined): string {
  return inlineStyles === false ? "" : openReceiveCheckoutStyleTag;
}

// Minimal "creating checkout" placeholder shown by a create-mode element (`order-id` with no
// `invoice`) while the checkout is being created, before the invoice/order-url attributes are
// populated and the normal checkout UI takes over.
/** Create-mode failure panel: inline message + retry (never an endless spinner). */
export function renderCheckoutCreateErrorHtml(
  message: string,
  options: RenderOpenReceiveStyleOptions & { readonly theme?: "light" | "dark" } = {},
): string {
  const resolvedTheme = options.theme ?? "light";
  return `
    ${styleTag(options.inlineStyles)}
    <section part="root" data-theme="${escapeHtml(resolvedTheme)}" class="${orClasses.root}" data-openreceive-create-error>
      <div part="status" role="alert" class="${orClasses.creating}">
        <div><strong>Could not start checkout.</strong></div>
        <p>${escapeHtml(message)}</p>
        <button part="retry" class="${orClasses.btn}" type="button">Try again</button>
      </div>
    </section>
  `;
}

export function renderCheckoutCreatingHtml(
  options: RenderOpenReceiveStyleOptions & { readonly theme?: "light" | "dark" } = {},
): string {
  const resolvedTheme = options.theme ?? "light";
  return `
    ${styleTag(options.inlineStyles)}
    <section part="root" data-theme="${escapeHtml(resolvedTheme)}" class="${orClasses.root}" data-openreceive-creating>
      <div part="status" class="${orClasses.creating}">
        <span part="spinner" class="${orClasses.spinner}" aria-hidden="true"></span>
        <div><strong>Creating checkout…</strong></div>
      </div>
    </section>
  `;
}

export function renderOpenReceiveThemeToggleHtml(
  label: string,
  options: RenderOpenReceiveStyleOptions = {},
): string {
  return `
    ${styleTag(options.inlineStyles)}
    <button
      aria-label="${escapeHtml(label)}"
      class="${orClasses.themeToggle}"
      part="${OPENRECEIVE_THEME_TOGGLE_ELEMENT_PARTS.button}"
      title="${escapeHtml(label)}"
      type="button"
      ${OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.themeToggle}
    >${escapeHtml(label)}</button>
  `;
}

const SETTLED_CHECK_ICON = `<svg part="settled-icon" class="${orClasses.settledIcon}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true" focusable="false"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg>`;

function renderElementPaymentStatusHtml(state: CheckoutState): string {
  const status = createCheckoutStatusModel(state);
  const countdown =
    status.countdownLabel === undefined
      ? ""
      : `<small part="countdown" class="${orClasses.countdown}">${escapeHtml(status.countdownPrefix)} <strong class="${orClasses.countdownStrong}">${escapeHtml(status.countdownLabel)}</strong></small>`;

  return `
    <div part="status" role="status" aria-live="polite" class="${orClasses.paymentStatus}">
      ${status.waiting ? `<span part="spinner" class="${orClasses.spinner}" aria-hidden="true"></span>` : ""}
      ${status.phase === "settled" ? SETTLED_CHECK_ICON : ""}
      <div class="${orClasses.paymentStatusBody}">
        <strong class="${orClasses.paymentStatusTitle}">${escapeHtml(status.title)}</strong>
        <p class="${orClasses.paymentStatusDetail}">${escapeHtml(status.detail)}</p>
        ${countdown}
      </div>
    </div>
  `;
}

function renderElementPaymentDataHtml(source: OpenReceivePaymentDataSource): string {
  const entries = createOpenReceivePaymentDataEntries(source);
  if (entries.length === 0) return "";
  const rows = entries
    .map(
      (entry) => `
        <div part="payment-data-row" class="${orClasses.paymentDataRow}">
          <span class="${orClasses.paymentDataKey}">${escapeHtml(entry.label)}</span>
          <p class="${orClasses.paymentDataValue}">${escapeHtml(entry.value)}</p>
        </div>`,
    )
    .join("");
  return `
    <details part="payment-data" class="${orClasses.paymentData}">
      <summary part="payment-data-summary" class="${orClasses.paymentDataTitle}">${escapeHtml(openReceiveCheckoutLabels.viewPaymentData)}</summary>
      <div class="${orClasses.paymentDataBody}">${rows}</div>
    </details>
  `;
}
