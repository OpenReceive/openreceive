import { isReusableLightningInvoice, selectCheckoutDisplayInvoice } from "./checkout.ts";
import type { CheckoutInvoiceSnapshot, CheckoutSnapshot } from "./ui.ts";

/**
 * The Lightning invoice a deferred-mint checkout can reuse instead of minting a
 * fresh bolt11: a lightning-rail invoice with a payable bolt11 and enough time
 * left on the clock (see {@link isReusableLightningInvoice}).
 */
export function findOpenReceiveReusableLightningInvoice(
  snapshot: CheckoutSnapshot,
  now?: number,
): CheckoutInvoiceSnapshot | undefined {
  return snapshot.invoices.find(
    (invoice) =>
      invoice.rail === "lightning" &&
      typeof invoice.invoice === "string" &&
      invoice.invoice.length > 0 &&
      invoice.expires_at !== undefined &&
      isReusableLightningInvoice(invoice.expires_at, now),
  );
}

/**
 * Fold a started attempt (swap deposit or minted bolt11) into a snapshot: the
 * attempt becomes the active invoice, its predecessor entry and any
 * checkout_lock placeholder drop out, and polling re-keys onto it.
 */
export function mergeOpenReceiveAttemptIntoSnapshot(
  invoice: CheckoutInvoiceSnapshot,
  base: CheckoutSnapshot,
): CheckoutSnapshot {
  const withoutSame = base.invoices.filter(
    (entry) => entry.invoice_id !== invoice.invoice_id && entry.rail !== "checkout_lock",
  );
  return {
    ...base,
    checkout_id: invoice.invoice_id,
    active: invoice,
    invoices: [invoice, ...withoutSame],
    ...(invoice.amount_msats === undefined ? {} : { amount_msats: invoice.amount_msats }),
  };
}

/**
 * {@link mergeOpenReceiveAttemptIntoSnapshot} with a minimal fallback snapshot
 * for hosts that started an attempt before any checkout snapshot existed.
 */
export function mergeOpenReceiveAttemptIntoCheckout(
  invoice: CheckoutInvoiceSnapshot,
  previous: CheckoutSnapshot | undefined,
  orderId: string,
): CheckoutSnapshot {
  const base =
    previous ??
    ({
      checkout_id: invoice.invoice_id,
      order_id: orderId,
      status: "open" as const,
      amount_msats: invoice.amount_msats ?? 0,
      invoices: [],
    } satisfies CheckoutSnapshot);
  return mergeOpenReceiveAttemptIntoSnapshot(invoice, base);
}

/**
 * Fold a freshly minted Lightning checkout into the running snapshot. The
 * minted bolt11 becomes the active invoice while `payment_methods` (and any
 * previously started attempts) from the prior snapshot are preserved — the
 * mint response does not carry the warmed method catalog.
 */
export function mergeOpenReceiveMintedCheckout(
  checkout: CheckoutSnapshot,
  previous: CheckoutSnapshot | undefined,
): CheckoutSnapshot {
  const minted = selectCheckoutDisplayInvoice(checkout) ?? checkout.active;
  if (minted === undefined) {
    return {
      ...checkout,
      ...(previous?.payment_methods === undefined
        ? {}
        : { payment_methods: previous.payment_methods }),
    };
  }
  if (previous === undefined) return mergeOpenReceiveAttemptIntoSnapshot(minted, checkout);
  return mergeOpenReceiveAttemptIntoSnapshot(minted, {
    ...previous,
    ...checkout,
    invoices: previous.invoices,
    payment_methods: previous.payment_methods ?? checkout.payment_methods,
  });
}
