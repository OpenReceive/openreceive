import {
  type OpenReceiveBrowserLogger,
  type OpenReceiveQrEncoder,
  copyInvoice,
  createLightningUri,
  createQrSvg,
  openWallet
} from "@openreceive/browser";

export { parseOpenReceiveInvoiceEvent } from "@openreceive/browser";
export type { OpenReceiveInvoiceEventPayload } from "@openreceive/browser";

export interface OpenReceiveCheckoutView {
  readonly invoice: string;
  readonly payment_hash?: string;
  readonly amount_msats?: number;
  readonly transaction_state?: string;
}

export interface DefineOpenReceiveElementsOptions {
  readonly tagName?: string;
  readonly registry?: CustomElementRegistry;
  readonly qrEncoder?: OpenReceiveQrEncoder;
  readonly logger?: OpenReceiveBrowserLogger;
}

const DEFAULT_TAG_NAME = "openreceive-checkout";

export function renderOpenReceiveCheckoutHtml(view: OpenReceiveCheckoutView): string {
  assertDisplaySafeInvoice(view.invoice);
  const lightningUri = createLightningUri(view.invoice);
  const amountLabel =
    view.amount_msats === undefined
      ? ""
      : `<span part="amount">${escapeHtml(formatMsats(view.amount_msats))}</span>`;
  const stateLabel =
    view.transaction_state === undefined
      ? ""
      : `<span part="state" data-state="${escapeHtml(view.transaction_state)}">${escapeHtml(view.transaction_state)}</span>`;
  const paymentHash =
    view.payment_hash === undefined
      ? ""
      : `<code part="payment-hash">${escapeHtml(shortHash(view.payment_hash))}</code>`;

  return `
    <style>
      :host {
        color: #171717;
        display: block;
        font: 14px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      [part="root"] {
        border: 1px solid #d4d4d4;
        border-radius: 8px;
        display: grid;
        gap: 12px;
        max-width: 320px;
        padding: 12px;
      }

      [part="qr"] {
        aspect-ratio: 1;
        align-items: center;
        background: #ffffff;
        border: 1px solid #e5e5e5;
        border-radius: 6px;
        display: flex;
        justify-content: center;
        min-width: 0;
        overflow: hidden;
      }

      [part="qr"] svg {
        display: block;
        height: 100%;
        width: 100%;
      }

      [part="meta"] {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      [part="state"] {
        background: #e8f5ee;
        border-radius: 999px;
        color: #11613b;
        padding: 2px 8px;
      }

      [part="payment-hash"] {
        color: #525252;
        font-size: 12px;
      }

      [part="invoice"] {
        background: #fafafa;
        border: 1px solid #e5e5e5;
        border-radius: 6px;
        box-sizing: border-box;
        color: #262626;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        min-height: 68px;
        overflow-wrap: anywhere;
        padding: 8px;
        resize: vertical;
        width: 100%;
      }

      [part="actions"] {
        display: grid;
        gap: 8px;
        grid-template-columns: 1fr 1fr;
      }

      button,
      a[part="open"] {
        align-items: center;
        border: 1px solid #171717;
        border-radius: 6px;
        box-sizing: border-box;
        color: #171717;
        cursor: pointer;
        display: inline-flex;
        font: inherit;
        justify-content: center;
        min-height: 40px;
        padding: 8px 10px;
        text-decoration: none;
      }

      button {
        background: #ffffff;
      }

      a[part="open"] {
        background: #171717;
        color: #ffffff;
      }
    </style>
    <section part="root">
      <div part="qr" data-openreceive-qr></div>
      <div part="meta">${amountLabel}${stateLabel}${paymentHash}</div>
      <textarea part="invoice" readonly>${escapeHtml(view.invoice)}</textarea>
      <div part="actions">
        <button part="copy" type="button">Copy</button>
        <a part="open" href="${escapeHtml(lightningUri)}">Open Wallet</a>
      </div>
    </section>
  `;
}

export function defineOpenReceiveElements(
  options: DefineOpenReceiveElementsOptions = {}
): void {
  const registry = options.registry ?? globalThis.customElements;
  const HTMLElementCtor = globalThis.HTMLElement;
  const tagName = options.tagName ?? DEFAULT_TAG_NAME;

  if (registry === undefined || HTMLElementCtor === undefined) {
    throw new Error("Custom elements are unavailable in this environment.");
  }

  if (registry.get(tagName) !== undefined) return;

  class OpenReceiveCheckoutElement extends HTMLElementCtor {
    static get observedAttributes() {
      return ["invoice", "payment-hash", "amount-msats", "transaction-state"];
    }

    connectedCallback() {
      this.render();
    }

    attributeChangedCallback() {
      if (this.isConnected) this.render();
    }

    render() {
      const invoice = this.getAttribute("invoice");
      if (invoice === null || invoice === "") {
        this.replaceChildren();
        return;
      }

      const root = this.shadowRoot ?? this.attachShadow({ mode: "open" });
      root.innerHTML = renderOpenReceiveCheckoutHtml({
        invoice,
        payment_hash: this.getAttribute("payment-hash") ?? undefined,
        amount_msats: parseOptionalInteger(this.getAttribute("amount-msats")),
        transaction_state: this.getAttribute("transaction-state") ?? undefined
      });

      root.querySelector('[part="copy"]')?.addEventListener("click", () => {
        void copyInvoice({ invoice, logger: options.logger })
          .then(() => this.dispatchEvent(new CustomEvent("openreceive-copy")))
          .catch((error) => this.dispatchError(error));
      });

      root.querySelector('[part="open"]')?.addEventListener("click", (event) => {
        event.preventDefault();
        try {
          openWallet({ invoice, logger: options.logger });
          this.dispatchEvent(new CustomEvent("openreceive-open-wallet"));
        } catch (error) {
          this.dispatchError(error);
        }
      });

      void createQrSvg(invoice, {
        encoder: options.qrEncoder,
        width: 256
      })
        .then((svg) => {
          const qr = root.querySelector("[data-openreceive-qr]");
          if (qr !== null) qr.innerHTML = svg;
        })
        .catch((error) => this.dispatchError(error));
    }

    private dispatchError(error: unknown): void {
      this.dispatchEvent(new CustomEvent("openreceive-error", {
        detail: {
          error
        }
      }));
    }
  }

  registry.define(tagName, OpenReceiveCheckoutElement);
}

export function formatMsats(amountMsats: number): string {
  if (!Number.isSafeInteger(amountMsats) || amountMsats < 0) {
    throw new RangeError("amount_msats must be a non-negative safe integer");
  }

  if (amountMsats % 1000 === 0) {
    const sats = amountMsats / 1000;
    return `${sats} ${sats === 1 ? "sat" : "sats"}`;
  }

  return `${amountMsats} msats`;
}

function parseOptionalInteger(value: string | null): number | undefined {
  if (value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RangeError("amount-msats must be a non-negative safe integer");
  }
  return parsed;
}

function shortHash(hash: string): string {
  return hash.length <= 16 ? hash : `${hash.slice(0, 8)}...${hash.slice(-8)}`;
}

function assertDisplaySafeInvoice(invoice: string): void {
  if (typeof invoice !== "string" || invoice.length === 0) {
    throw new TypeError("invoice must be a non-empty BOLT11 string");
  }

  if (invoice.startsWith("nostr+walletconnect://")) {
    throw new TypeError("invoice must not be an NWC connection string");
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
