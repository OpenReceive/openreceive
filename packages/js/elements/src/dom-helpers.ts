import {
  createOpenReceiveDetailExternalLink,
  createOpenReceiveTransientFeedbackController,
  escapeOpenReceiveHtml as escapeHtml,
  OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES,
  OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES,
  OPENRECEIVE_PAYMENT_WIZARD_SELECTORS,
  openReceiveCheckoutLabels,
  orClasses,
} from "@openreceive/browser/internal";

export const COPY_INVOICE_ICON = `<svg class="${orClasses.copyIcon}" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false"><rect x="5" y="5" width="8" height="9" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M3.5 11V3.5A1.5 1.5 0 0 1 5 2h5.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

const elementCopyFeedbackControllers = new WeakMap<
  Element,
  ReturnType<typeof createOpenReceiveTransientFeedbackController<string>>
>();

export function readElementFiatQuote(element: Element) {
  const currency = element.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.fiatCurrency);
  const value = element.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.fiatValue);
  if (currency === null || value === null) return undefined;
  return {
    fiat: {
      currency,
      value,
    },
  };
}

export function parseElementRail(value: string | null): "lightning" | "swap" | "checkout_lock" {
  if (value === "swap") return "swap";
  if (value === "checkout_lock") return "checkout_lock";
  return "lightning";
}

export function showElementCopyFeedback(button: Element | null): void {
  if (button === null) return;
  let controller = elementCopyFeedbackControllers.get(button);
  if (controller === undefined) {
    const labelEl = button.querySelector(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.swapCopyLabel);
    const resetValue =
      button.getAttribute("aria-label")?.trim() ||
      labelEl?.textContent?.trim() ||
      button.textContent?.trim() ||
      openReceiveCheckoutLabels.copyInvoice;
    controller = createOpenReceiveTransientFeedbackController({
      resetValue,
      onValue: (label) => {
        if (!button.isConnected) return;
        if (button instanceof HTMLElement && button.hasAttribute("aria-label")) {
          button.setAttribute("aria-label", label);
          button.setAttribute("title", label);
        }
        if (labelEl instanceof HTMLElement) {
          labelEl.textContent = label;
          return;
        }
        if (!(button instanceof HTMLElement && button.querySelector("svg"))) {
          button.textContent = label;
        }
      },
    });
    elementCopyFeedbackControllers.set(button, controller);
  }
  controller.show(openReceiveCheckoutLabels.copied);
}

export function wireSwapSelectAllInputs(root: ParentNode): void {
  for (const input of root.querySelectorAll(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.swapSelectAll)) {
    if (!(input instanceof HTMLInputElement)) continue;
    const selectAll = () => {
      input.select();
    };
    input.addEventListener("focus", selectAll);
    input.addEventListener("click", selectAll);
    input.addEventListener("mouseup", (event) => {
      event.preventDefault();
    });
    input.addEventListener("select", () => {
      if (input.selectionStart !== 0 || input.selectionEnd !== input.value.length) {
        input.setSelectionRange(0, input.value.length);
      }
    });
  }
}
export function renderElementSwapCopyDetailHtml(
  label: string,
  value: string,
  displayValue: string = value,
  payInAsset?: string,
  href?: string,
  hrefLabel?: string,
): string {
  const link =
    href === undefined
      ? createOpenReceiveDetailExternalLink({
          label,
          value,
          ...(payInAsset === undefined ? {} : { payInAsset }),
        })
      : {
          href,
          hrefLabel: hrefLabel ?? openReceiveCheckoutLabels.viewOnExplorer,
        };
  const external =
    link === undefined
      ? ""
      : `<a
        part="swap-external"
        class="${orClasses.swapDetailsLink}"
        href="${escapeHtml(link.href)}"
        rel="noreferrer"
        target="_blank"
      >${escapeHtml(link.hrefLabel)}</a>`;
  const valueField =
    label === "Address" || label === "Amount"
      ? `<input
          class="${orClasses.swapDetailsInput}"
          type="text"
          readonly
          value="${escapeHtml(displayValue)}"
          aria-label="${escapeHtml(label)}"
          ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapSelectAll}
        />`
      : `<code class="${orClasses.swapDetailsCode}">${escapeHtml(displayValue)}</code>`;
  return `
    <dt class="${orClasses.swapDetailsDt}">${escapeHtml(label)}</dt>
    <dd class="${orClasses.swapDetailsDd}">
      ${valueField}
      <div class="${orClasses.swapDetailsActions}">
        <button
          part="swap-copy"
          class="${orClasses.detailCopy}"
          aria-label="Copy"
          title="Copy"
          ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapCopy}="${escapeHtml(value)}"
          type="button"
        >${COPY_INVOICE_ICON}</button>
        ${external}
      </div>
    </dd>
  `;
}
