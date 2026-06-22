import type { StoredRecord } from "../storage/kv.ts";
import {
  gatedLookup,
  maybeSweep,
  reconcileOnce,
  type OpenReceiveGatedLookupResult,
  type OpenReceiveMaybeSweepResult,
  type OpenReceiveReconcileOnceResult,
  type OpenReceiveReconcileOptions,
  type OpenReceiveSettlementActionInput
} from "./reconcile.ts";

export * from "./reconcile.ts";

export interface OpenReceiveReconciler {
  lookupInvoice(input: {
    record: StoredRecord;
    source?: OpenReceiveSettlementActionInput["source"];
  }): Promise<OpenReceiveGatedLookupResult>;
  reconcileOnce(): Promise<OpenReceiveReconcileOnceResult>;
  maybeSweep(): Promise<OpenReceiveMaybeSweepResult>;
}

export function createOpenReceiveReconciler(
  options: OpenReceiveReconcileOptions
): OpenReceiveReconciler {
  return {
    lookupInvoice(input) {
      return gatedLookup({
        ...options,
        ...input
      });
    },
    reconcileOnce() {
      return reconcileOnce(options);
    },
    maybeSweep() {
      return maybeSweep(options);
    }
  };
}
