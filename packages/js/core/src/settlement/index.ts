import {
  isTransactionSettled,
  isTransactionState,
  type NwcTransaction,
  type TransactionState,
} from "../nwc/client.ts";

export type SettlementFinalitySignal = "settled_at" | "state" | "transaction_state";

/**
 * The one status vocabulary. Every other status in OpenReceive is this union
 * plus one documented extension: `PaymentStatus` adds `not_found` (a scan
 * result), the HTTP repository's `AttemptStatus` adds `attention`
 * (an operator state), and the browser's `Status` is exactly this.
 */
export type TransactionSettlementStatus = "pending" | "settled" | "expired" | "failed";

export interface TransactionSettlementDetection {
  readonly settled: boolean;
  readonly status: TransactionSettlementStatus;
  readonly finality_signal?: SettlementFinalitySignal;
  readonly transaction_state?: TransactionState;
  readonly state?: TransactionState;
  readonly settled_at?: number;
  readonly preimage_present: boolean;
}

export function getSettlementFinalitySignal(
  result: NwcTransaction,
): SettlementFinalitySignal | undefined {
  if (!isTransactionSettled(result)) return undefined;
  // Same field precedence as isTransactionSettled — the rule that actually
  // decides settlement — so the reported signal is the one that fired.
  if (result.settled_at !== undefined && result.settled_at > 0) return "settled_at";
  if (isTransactionState(result.transaction_state, "settled")) return "transaction_state";
  if (isTransactionState(result.state, "settled")) return "state";
  return undefined;
}

export function isTransactionExpired(result: NwcTransaction): boolean {
  return (
    isTransactionState(result.state, "expired") ||
    isTransactionState(result.transaction_state, "expired")
  );
}

export function isTransactionFailed(result: NwcTransaction): boolean {
  return (
    isTransactionState(result.state, "failed") ||
    isTransactionState(result.transaction_state, "failed")
  );
}

export function classifyTransactionSettlement(
  result: NwcTransaction,
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
  finalitySignal?: SettlementFinalitySignal,
): TransactionSettlementDetection {
  return {
    settled: status === "settled",
    status,
    ...(finalitySignal === undefined ? {} : { finality_signal: finalitySignal }),
    ...(result.transaction_state === undefined
      ? {}
      : { transaction_state: result.transaction_state }),
    ...(result.state === undefined ? {} : { state: result.state }),
    ...(result.settled_at === undefined ? {} : { settled_at: result.settled_at }),
    preimage_present: result.preimage !== undefined,
  };
}
