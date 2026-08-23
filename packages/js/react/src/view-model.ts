import {
  createCheckoutState,
  selectCheckoutDisplayInvoice,
  status as deriveStatus,
  type CheckoutSnapshot,
  type Status,
} from "@openreceive/browser/headless";
import type { CheckoutData, CheckoutViewModel } from "./types.ts";

/**
 * The COARSE status of the whole checkout, not of the displayed attempt.
 *
 * A checkout paid via a swap has a settled shadow attempt and a still-pending
 * Lightning attempt; the payer must be told the order is paid, so the
 * checkout's own status wins over whatever the displayed attempt says.
 */
export function deriveCheckoutOrderStatus(snapshot: CheckoutSnapshot): Status {
  if (snapshot.status === "paid") return "settled";
  if (snapshot.status === "expired") return "expired";
  const invoice = selectCheckoutDisplayInvoice(snapshot);
  return invoice === undefined ? "pending" : deriveStatus(invoice);
}

/**
 * Snapshot -> everything React needs to render it, in one hop.
 *
 * This used to be three: toCheckoutDisplayData -> createCheckoutDisplayModel ->
 * toCheckoutViewModel, a second copy of the flattening rule that
 * `createCheckoutState` already owned. Logging is off because this is a pure
 * projection a host may call as often as it renders; `useCheckout` builds its
 * state through the controller, which does the logging exactly once.
 */
export function createCheckoutViewModel(data: CheckoutData): CheckoutViewModel {
  return {
    ...createCheckoutState(data.checkout, { logger: false }),
    status: deriveCheckoutOrderStatus(data.checkout),
  };
}
