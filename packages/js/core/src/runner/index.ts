import type { StoredRecord } from "../storage/kv.ts";
import {
  refreshStoredInvoiceStatus,
  type OpenReceiveReconcileOptions,
  type OpenReceiveStatusRefreshResult,
} from "./reconcile.ts";

export {
  refreshStoredInvoiceStatus,
  refreshStoredInvoiceRecordsStatus,
  sweepPendingInvoicesOnce,
  runSettlementAction,
} from "./reconcile.ts";
export type {
  OpenReceiveReconcileEventName,
  OpenReceiveReconcileEvent,
  OpenReceiveSettlementActionInput,
  OpenReceiveReconcileOptions,
  OpenReceiveStatusRefreshStatus,
  OpenReceiveStatusRefreshResult,
  OpenReceiveOrderStatusRefreshResult,
  OpenReceivePendingSweepReason,
  OpenReceivePendingSweepResult,
} from "./reconcile.ts";

export interface OpenReceiveReconciler {
  refreshStoredInvoiceStatus(input: {
    record: StoredRecord;
  }): Promise<OpenReceiveStatusRefreshResult>;
}

export function createOpenReceiveReconciler(
  options: OpenReceiveReconcileOptions,
): OpenReceiveReconciler {
  return {
    refreshStoredInvoiceStatus(input) {
      return refreshStoredInvoiceStatus({
        ...options,
        ...input,
      });
    },
  };
}
