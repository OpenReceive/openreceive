/**
 * Hello Fruit transaction-details helpers — thin re-exports of package UI.
 * Prefer `@openreceive/react` `<TransactionDetails>` and
 * `@openreceive/elements` `createTransactionDetailsElement` directly.
 */

export {
  createTransactionDetailsElement as createHelloFruitTransactionDetailsElement,
  renderTransactionDetailsHtml as renderHelloFruitTransactionDetailsHtml,
  wireTransactionDetailsCopy as wireHelloFruitTransactionDetailsCopy,
  type TransactionDetailsSource as HelloFruitTransactionDetailsSource,
} from "@openreceive/elements";

export { openReceiveCheckoutLabels } from "@openreceive/browser/internal";

import {
  createOpenReceiveTransactionDetails,
  createOpenReceiveTransactionDetailsFromState,
  type CheckoutState,
  type OpenReceiveTransactionDetailRow,
  type OpenReceiveTransactionDetailsInput,
} from "@openreceive/browser/internal";

export function buildHelloFruitTransactionDetailRows(
  source: CheckoutState | OpenReceiveTransactionDetailsInput | null | undefined,
): OpenReceiveTransactionDetailRow[] {
  if (source === null || source === undefined) return [];
  if (isCheckoutState(source)) {
    return createOpenReceiveTransactionDetailsFromState(source);
  }
  return createOpenReceiveTransactionDetails(source);
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
