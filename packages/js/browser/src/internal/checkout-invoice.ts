// BOLT11 safety: the guards that keep a wallet connection string (or any
// other non-invoice) out of a QR, a clipboard, or a rendered link, plus the
// one place that builds a `lightning:` URI. Every path that shows or copies an
// invoice goes through `assertInvoice` first.

export function assertOpenReceiveDisplayInvoice(invoice: string): void {
  assertInvoice(invoice);
}

export function createLightningUri(invoice: string): string {
  assertInvoice(invoice);
  return `lightning:${invoice}`;
}

export function assertInvoice(invoice: string): void {
  if (typeof invoice !== "string" || invoice.length === 0) {
    throw new TypeError("invoice must be a non-empty BOLT11 string");
  }

  if (invoice.startsWith("nostr+walletconnect://")) {
    throw new TypeError("invoice must not be an NWC connection string");
  }
}

export function assertOpenReceiveBrowserPayloadSafe(value: unknown): void {
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
