import {
  escapeOpenReceiveHtml as escapeHtml,
  OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES,
  OPENRECEIVE_PAYMENT_WIZARD_SELECTORS,
  type OpenReceiveTransactionDetailsSource,
  openReceiveCheckoutLabels,
  orClasses,
  resolveOpenReceiveTransactionDetailRows,
} from "@openreceive/browser/headless";

import {
  renderElementSwapCopyDetailHtml,
  showElementCopyFeedback,
  wireSwapSelectAllInputs,
} from "./dom-helpers.ts";

/**
 * Collapsible transaction-details panel as an HTML string (vanilla / elements hosts).
 * Uses the same row builder as React `<TransactionDetails>`.
 */
export function renderTransactionDetailsHtml(
  source: OpenReceiveTransactionDetailsSource,
  options: {
    readonly open?: boolean;
    readonly className?: string;
  } = {},
): string {
  const rows = resolveOpenReceiveTransactionDetailRows(source);
  if (rows.length === 0) return "";
  const openAttr = options.open === true ? " open" : "";
  const className = options.className ?? orClasses.transactionDetails;
  return `
    <details part="transaction-details" class="${escapeHtml(className)}"${openAttr}>
      <summary class="${orClasses.transactionDetailsTitle}">${escapeHtml(openReceiveCheckoutLabels.transactionDetails)}</summary>
      <div class="${orClasses.transactionDetailsContent}">
        <dl part="swap-details" class="${orClasses.swapDetails}">
          ${rows
            .map((row) =>
              renderElementSwapCopyDetailHtml(
                row.label,
                row.copyValue ?? row.value,
                row.value,
                undefined,
                row.href,
                row.hrefLabel,
              ),
            )
            .join("")}
        </dl>
      </div>
    </details>
  `;
}

export function createTransactionDetailsElement(
  source: OpenReceiveTransactionDetailsSource,
  options: {
    readonly open?: boolean;
    readonly className?: string;
    readonly onCopyError?: (error: unknown) => void;
    readonly document?: Document;
  } = {},
): HTMLElement | null {
  const html = renderTransactionDetailsHtml(source, options);
  if (html === "") return null;
  const doc = options.document ?? globalThis.document;
  const host = doc.createElement("div");
  host.innerHTML = html.trim();
  const details = host.firstElementChild;
  if (!(details instanceof HTMLElement)) return null;
  wireTransactionDetailsCopy(details, options.onCopyError);
  return details;
}

export function wireTransactionDetailsCopy(
  root: ParentNode,
  onCopyError?: (error: unknown) => void,
): void {
  wireSwapSelectAllInputs(root);
  for (const button of root.querySelectorAll(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.swapCopy)) {
    if (!(button instanceof HTMLButtonElement)) continue;
    button.addEventListener("click", () => {
      const value = button.getAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapCopy);
      if (value === null || value === "") return;
      void globalThis.navigator?.clipboard
        ?.writeText(value)
        .then(() => showElementCopyFeedback(button))
        .catch((error) => onCopyError?.(error));
    });
  }
}
