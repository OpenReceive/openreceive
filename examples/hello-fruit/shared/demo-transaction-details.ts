import {
  createOpenReceiveTransactionDetails,
  createOpenReceiveTransactionDetailsFromState,
  openReceiveCheckoutLabels,
  type CheckoutState,
  type OpenReceiveTransactionDetailRow,
  type OpenReceiveTransactionDetailsInput,
} from "@openreceive/browser/internal";

export { openReceiveCheckoutLabels };

export type HelloFruitTransactionDetailsSource =
  | CheckoutState
  | OpenReceiveTransactionDetailsInput
  | null
  | undefined;

export function buildHelloFruitTransactionDetailRows(
  source: HelloFruitTransactionDetailsSource,
): OpenReceiveTransactionDetailRow[] {
  if (source === null || source === undefined) return [];
  if (isCheckoutState(source)) {
    return createOpenReceiveTransactionDetailsFromState(source);
  }
  return createOpenReceiveTransactionDetails(source);
}

export function renderHelloFruitTransactionDetailsHtml(
  source: HelloFruitTransactionDetailsSource,
  options: {
    readonly open?: boolean;
    readonly className?: string;
  } = {},
): string {
  const rows = buildHelloFruitTransactionDetailRows(source);
  if (rows.length === 0) return "";
  const openAttr = options.open === true ? " open" : "";
  const className = options.className ?? "collapse collapse-arrow bg-base-200";
  return `
    <details class="${escapeHtml(className)}"${openAttr}>
      <summary class="collapse-title font-bold min-h-0 py-2">${escapeHtml(openReceiveCheckoutLabels.transactionDetails)}</summary>
      <div class="collapse-content">
        <dl class="grid gap-2 m-0">
          ${rows
            .map(
              (row) => `
            <dt class="text-base-content/60 text-xs font-bold uppercase">${escapeHtml(row.label)}</dt>
            <dd class="grid gap-2 grid-cols-[minmax(0,1fr)_auto] items-center m-0">
              <code class="min-w-0 break-all font-mono text-sm">${escapeHtml(row.value)}</code>
              <div class="flex flex-wrap gap-2 justify-end">
                <button
                  class="btn btn-sm btn-soft"
                  type="button"
                  data-hello-fruit-copy="${escapeHtml(row.copyValue ?? row.value)}"
                >Copy</button>
                ${
                  row.href === undefined
                    ? ""
                    : `<a
                  class="btn btn-sm btn-soft"
                  href="${escapeHtml(row.href)}"
                  rel="noreferrer"
                  target="_blank"
                >${escapeHtml(row.hrefLabel ?? openReceiveCheckoutLabels.viewOnExplorer)}</a>`
                }
              </div>
            </dd>
          `,
            )
            .join("")}
        </dl>
      </div>
    </details>
  `;
}

export function createHelloFruitTransactionDetailsElement(
  source: HelloFruitTransactionDetailsSource,
  options: {
    readonly open?: boolean;
    readonly className?: string;
    readonly onCopyError?: (error: unknown) => void;
  } = {},
): HTMLElement | null {
  const html = renderHelloFruitTransactionDetailsHtml(source, options);
  if (html === "") return null;
  const host = document.createElement("div");
  host.innerHTML = html.trim();
  const details = host.firstElementChild;
  if (!(details instanceof HTMLElement)) return null;
  wireHelloFruitTransactionDetailsCopy(details, options.onCopyError);
  return details;
}

export function wireHelloFruitTransactionDetailsCopy(
  root: ParentNode,
  onCopyError?: (error: unknown) => void,
): void {
  for (const button of root.querySelectorAll("[data-hello-fruit-copy]")) {
    if (!(button instanceof HTMLButtonElement)) continue;
    button.addEventListener("click", () => {
      const value = button.getAttribute("data-hello-fruit-copy");
      if (value === null || value === "") return;
      const original = button.textContent ?? "Copy";
      void navigator.clipboard
        .writeText(value)
        .then(() => {
          button.textContent = openReceiveCheckoutLabels.copied;
          globalThis.setTimeout(() => {
            button.textContent = original;
          }, 1500);
        })
        .catch((error) => onCopyError?.(error));
    });
  }
}

function isCheckoutState(value: object): value is CheckoutState {
  return (
    "checkout_id" in value &&
    "order_id" in value &&
    "invoice_id" in value &&
    "invoice" in value &&
    "transaction_state" in value &&
    "phase" in value
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
