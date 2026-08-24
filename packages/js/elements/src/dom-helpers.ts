import {
  createDetailExternalLink,
  type DetailLinkKind,
  createTransientFeedbackController,
  escapeHtml,
  OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES,
  OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES,
  OPENRECEIVE_PAYMENT_WIZARD_SELECTORS,
  checkoutLabels,
  orClasses,
} from "@openreceive/browser/headless";

export const COPY_INVOICE_ICON = `<svg class="${orClasses.copyIcon}" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false"><rect x="5" y="5" width="8" height="9" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M3.5 11V3.5A1.5 1.5 0 0 1 5 2h5.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

const elementCopyFeedbackControllers = new WeakMap<
  Element,
  ReturnType<typeof createTransientFeedbackController<string>>
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

/**
 * Non-throwing number read for the attributes `createCheckoutElementAttributes`
 * writes from server data (`amount-msats`, `expires-at`): create mode
 * legitimately omits them, so missing or empty answers undefined — a DOM
 * concern, not a judgement of the value. The parsed number is kept RAW.
 * `poll-interval-ms` is different: only the host's own options ever write it,
 * so a typo there should be heard, and it stays on the strict
 * `parseOptionalInteger` in `startCheckoutController`.
 */
function readElementNumberAttribute(element: Element, attribute: string): number | undefined {
  const raw = element.getAttribute(attribute);
  if (raw === null || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function readElementAmountMsats(element: Element): number | undefined {
  return readElementNumberAttribute(element, OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.amountMsats);
}

export function readElementExpiresAt(element: Element): number | undefined {
  return readElementNumberAttribute(element, OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.expiresAt);
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
      checkoutLabels.copyInvoice;
    controller = createTransientFeedbackController({
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
  controller.show(checkoutLabels.copied);
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
  options: {
    readonly displayValue?: string;
    /** What the value IS. Omitted, the row carries no external link. */
    readonly kind?: DetailLinkKind;
    readonly payInAsset?: string;
    readonly href?: string;
    readonly hrefLabel?: string;
    /** Render the value in a selectable input rather than a code block. */
    readonly selectable?: boolean;
  } = {},
): string {
  const displayValue = options.displayValue ?? value;
  const link =
    options.href === undefined
      ? options.kind === undefined
        ? undefined
        : createDetailExternalLink({
            kind: options.kind,
            value,
            ...(options.payInAsset === undefined ? {} : { payInAsset: options.payInAsset }),
          })
      : {
          href: options.href,
          hrefLabel: options.hrefLabel ?? checkoutLabels.viewOnExplorer,
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
    options.selectable === true
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
