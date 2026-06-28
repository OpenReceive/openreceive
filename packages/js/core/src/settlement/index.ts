import {
  isTransactionSettled,
  type NwcTransaction,
  type OpenReceiveTransactionState
} from "../nwc/client.ts";

export type SettlementFinalitySignal =
  | "settled_at"
  | "state"
  | "transaction_state";

export type TransactionSettlementStatus =
  | "pending"
  | "settled"
  | "expired"
  | "failed";

export interface TransactionSettlementDetection {
  settled: boolean;
  status: TransactionSettlementStatus;
  finality_signal?: SettlementFinalitySignal;
  transaction_state?: OpenReceiveTransactionState;
  state?: OpenReceiveTransactionState;
  settled_at?: number;
  preimage_present: boolean;
}

export function getSettlementFinalitySignal(
  result: NwcTransaction
): SettlementFinalitySignal | undefined {
  if (!isTransactionSettled(result)) return undefined;
  if (result.settled_at !== undefined) return "settled_at";
  if (result.state === "settled") return "state";
  if (result.transaction_state === "settled") return "transaction_state";
  return undefined;
}

export function isTransactionFinal(result: NwcTransaction): boolean {
  return isTransactionSettled(result);
}

export function isTransactionExpired(result: NwcTransaction): boolean {
  return result.state === "expired" || result.transaction_state === "expired";
}

export function isTransactionFailed(result: NwcTransaction): boolean {
  return result.state === "failed" || result.transaction_state === "failed";
}

export function classifyTransactionSettlement(
  result: NwcTransaction
): TransactionSettlementDetection {
  const finalitySignal = getSettlementFinalitySignal(result);

  if (finalitySignal !== undefined) {
    return transactionSettlementDetection(result, "settled", finalitySignal);
  }

  if (isTransactionExpired(result)) {
    return transactionSettlementDetection(result, "expired");
  }

  if (isTransactionFailed(result)) {
    return transactionSettlementDetection(result, "failed");
  }

  return transactionSettlementDetection(result, "pending");
}

function transactionSettlementDetection(
  result: NwcTransaction,
  status: TransactionSettlementStatus,
  finalitySignal?: SettlementFinalitySignal
): TransactionSettlementDetection {
  const detection: TransactionSettlementDetection = {
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
