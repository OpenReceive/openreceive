import {
  createCheckoutDisplayModel,
  selectCheckoutDisplayInvoice,
  status as deriveStatus,
  type CheckoutDisplayData,
  type CheckoutDisplayModel,
  type CheckoutSnapshot,
  type Status,
} from "@openreceive/browser/internal";
import type { CheckoutData, CheckoutViewModel } from "./types.ts";

export function toCheckoutDisplayData(snapshot: CheckoutSnapshot): CheckoutDisplayData {
  const invoice = selectCheckoutDisplayInvoice(snapshot);
  // Deferred checkout (checkout_lock with no bolt11 minted yet) — return a minimal stub
  // with an empty invoice string. Callers must gate all bolt11-dependent UI on lightning
  // actually being requested/visible (rail === "checkout_lock" or invoice === "").
  if (invoice === undefined) {
    return {
      checkout_id: snapshot.checkout_id,
      order_id: snapshot.order_id,
      invoice_id: "",
      invoice: "",
      rail: "checkout_lock",
      ...(snapshot.amount_msats !== undefined ? { amount_msats: snapshot.amount_msats } : {}),
      ...(snapshot.fiat !== undefined ? { fiat_quote: { fiat: snapshot.fiat } } : {}),
    };
  }
  if (typeof invoice.invoice !== "string") {
    throw new TypeError("OpenReceive checkout requires a display Lightning invoice.");
  }
  const fiatQuote =
    invoice.fiat_quote === null && snapshot.fiat !== undefined
      ? { fiat: snapshot.fiat }
      : (invoice.fiat_quote ?? (snapshot.fiat === undefined ? undefined : { fiat: snapshot.fiat }));
  const settledAt = snapshot.paid_at ?? invoice.settled_at;
  return {
    checkout_id: snapshot.checkout_id,
    order_id: snapshot.order_id,
    invoice_id: invoice.invoice_id,
    invoice: invoice.invoice,
    rail: invoice.rail,
    ...(invoice.payment_hash === undefined ? {} : { payment_hash: invoice.payment_hash }),
    ...(invoice.amount_msats === undefined ? {} : { amount_msats: invoice.amount_msats }),
    ...(fiatQuote === undefined ? {} : { fiat_quote: fiatQuote }),
    ...(invoice.transaction_state === undefined
      ? {}
      : { transaction_state: invoice.transaction_state }),
    ...(invoice.workflow_state === undefined ? {} : { workflow_state: invoice.workflow_state }),
    ...(invoice.expires_at === undefined ? {} : { expires_at: invoice.expires_at }),
    ...(settledAt === undefined ? {} : { settled_at: settledAt }),
    ...(invoice.swap === undefined ? {} : { swap: invoice.swap }),
  };
}

export function deriveCheckoutOrderStatus(snapshot: CheckoutSnapshot): Status {
  if (snapshot.status === "paid") return "settled";
  if (snapshot.status === "expired") return "expired";
  const invoice = selectCheckoutDisplayInvoice(snapshot);
  return invoice === undefined ? "pending" : deriveStatus(invoice);
}

export function toCheckoutViewModel(
  display: CheckoutDisplayModel,
  currentStatus: Status,
): CheckoutViewModel {
  return {
    invoice_id: display.invoice_id,
    invoice: display.invoice,
    ...(display.payment_hash === undefined ? {} : { payment_hash: display.payment_hash }),
    ...(display.amount_msats === undefined ? {} : { amount_msats: display.amount_msats }),
    ...(display.fiat_quote === undefined ? {} : { fiat_quote: display.fiat_quote }),
    ...(display.expires_at === undefined ? {} : { expires_at: display.expires_at }),
    ...(display.settled_at === undefined ? {} : { settled_at: display.settled_at }),
    lightning_uri: display.lightning_uri,
    ...(display.amountLabel === undefined ? {} : { amountLabel: display.amountLabel }),
    ...(display.fiatLabel === undefined ? {} : { fiatLabel: display.fiatLabel }),
    ...(display.paymentHashLabel === undefined
      ? {}
      : { paymentHashLabel: display.paymentHashLabel }),
    status: currentStatus,
  };
}

export function createCheckoutViewModel(data: CheckoutData): CheckoutViewModel {
  return toCheckoutViewModel(
    createCheckoutDisplayModel(toCheckoutDisplayData(data.checkout)),
    deriveCheckoutOrderStatus(data.checkout),
  );
}

export function resolveCheckoutStatusRefreshUrl(options: {
  readonly orderUrl?: string | false;
  readonly polling?: boolean;
}): string | undefined {
  if (options.polling === false || options.orderUrl === false) return undefined;
  return options.orderUrl;
}
