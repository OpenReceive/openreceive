import {
  isLookupSettled,
  type LookupInvoiceResult,
  type OpenReceiveTransactionState
} from "../nwc/client.js";

export type SettlementFinalitySignal =
  | "settled_at"
  | "state"
  | "transaction_state";

export type LookupInvoiceSettlementStatus =
  | "pending"
  | "settled"
  | "expired"
  | "failed";

export interface LookupInvoiceSettlementDetection {
  settled: boolean;
  status: LookupInvoiceSettlementStatus;
  finality_signal?: SettlementFinalitySignal;
  transaction_state?: OpenReceiveTransactionState;
  state?: OpenReceiveTransactionState;
  settled_at?: number;
  preimage_present: boolean;
}

export function getSettlementFinalitySignal(
  result: LookupInvoiceResult
): SettlementFinalitySignal | undefined {
  if (!isLookupSettled(result)) return undefined;
  if (result.settled_at !== undefined) return "settled_at";
  if (result.state === "settled") return "state";
  if (result.transaction_state === "settled") return "transaction_state";
  return undefined;
}

export function isLookupInvoiceSettled(result: LookupInvoiceResult): boolean {
  return isLookupSettled(result);
}

export function isLookupInvoiceExpired(result: LookupInvoiceResult): boolean {
  return result.state === "expired" || result.transaction_state === "expired";
}

export function isLookupInvoiceFailed(result: LookupInvoiceResult): boolean {
  return result.state === "failed" || result.transaction_state === "failed";
}

export function classifyLookupInvoiceSettlement(
  result: LookupInvoiceResult
): LookupInvoiceSettlementDetection {
  const finalitySignal = getSettlementFinalitySignal(result);

  if (finalitySignal !== undefined) {
    return lookupInvoiceSettlementDetection(result, "settled", finalitySignal);
  }

  if (isLookupInvoiceExpired(result)) {
    return lookupInvoiceSettlementDetection(result, "expired");
  }

  if (isLookupInvoiceFailed(result)) {
    return lookupInvoiceSettlementDetection(result, "failed");
  }

  return lookupInvoiceSettlementDetection(result, "pending");
}

function lookupInvoiceSettlementDetection(
  result: LookupInvoiceResult,
  status: LookupInvoiceSettlementStatus,
  finalitySignal?: SettlementFinalitySignal
): LookupInvoiceSettlementDetection {
  const detection: LookupInvoiceSettlementDetection = {
    settled: status === "settled",
    status,
    preimage_present: result.preimage !== undefined
  };

  if (finalitySignal !== undefined) {
    detection.finality_signal = finalitySignal;
  }

  if (result.transaction_state !== undefined) {
    detection.transaction_state = result.transaction_state;
  }

  if (result.state !== undefined) {
    detection.state = result.state;
  }

  if (result.settled_at !== undefined) {
    detection.settled_at = result.settled_at;
  }

  return detection;
}
