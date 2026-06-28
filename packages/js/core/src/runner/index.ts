import type { StoredRecord } from "../storage/kv.ts";
import {
  refreshInvoiceStatus,
  type OpenReceiveReconcileOptions,
  type OpenReceiveStatusRefreshResult
} from "./reconcile.ts";

export * from "./reconcile.ts";

export interface OpenReceiveReconciler {
  refreshInvoiceStatus(input: {
    record: StoredRecord;
  }): Promise<OpenReceiveStatusRefreshResult>;
}

export function createOpenReceiveReconciler(
  options: OpenReceiveReconcileOptions
): OpenReceiveReconciler {
  return {
    refreshInvoiceStatus(input) {
      return refreshInvoiceStatus({
        ...options,
        ...input
      });
    }
  };
}
