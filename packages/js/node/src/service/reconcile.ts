import type {
  OpenReceiveReconcileEvent,
  OpenReceiveSettlementActionInput,
} from "@openreceive/core";
import { emitLog, invoiceLogFields, publicSettlementMetadata } from "./logging.ts";
import { readStoredCheckoutId, readStoredOrderId } from "./models.ts";
import type { OpenReceiveServiceContext } from "./types.ts";

export function reconcileOptions(context: OpenReceiveServiceContext) {
  return {
    store: context.store,
    client: context.options.client,
    clock: context.clock,
    actionLeaseTtlSeconds: context.options.actionLeaseTtlSeconds,
    transactionScanIntervalSeconds: context.options.transactionScanIntervalSeconds,
    transactionScanPageLimit: context.options.transactionScanPageLimit,
    transactionScanWindowPaddingSeconds: context.options.transactionScanWindowPaddingSeconds,
    transactionScanOverlapSeconds: context.options.transactionScanOverlapSeconds,
    sweepOpenInvoiceCap: context.options.sweepOpenInvoiceCap,
    transactionScanTimeoutMs: context.options.transactionScanTimeoutMs,
    settlementAction: async (input: OpenReceiveSettlementActionInput) => {
      // Delivered after backend-verified settlement, at least once. Apps must
      // dedupe fulfillment by checkoutId or their own order id.
      await context.options.onPaid?.({
        invoice: input.invoice,
        orderId: readStoredOrderId(input.invoice),
        checkoutId: readStoredCheckoutId(input.invoice),
        invoiceId: input.invoice.invoice_id,
        paymentHash: input.invoice.payment_hash,
        amountMsats: input.invoice.amount_msats,
        metadata: publicSettlementMetadata(input.metadata),
        source: input.source,
        transaction: input.transaction,
      });
    },
    onEvent: (event: OpenReceiveReconcileEvent) => {
      emitLog(
        context.options,
        reconcileLogLevel(event),
        event.event,
        "OpenReceive refreshed invoice state.",
        {
          ...invoiceLogFields(event.invoice),
          ...(event.reason === undefined ? {} : { reason: event.reason }),
        },
      );
    },
  };
}

function reconcileLogLevel(
  event: OpenReceiveReconcileEvent
): "debug" | "info" | "warn" {
  if (event.event === "invoice.failed" || event.event === "transaction_scan.failed") {
    return "warn";
  }
  if (event.event === "invoice.verifying") return "debug";
  return "info";
}
