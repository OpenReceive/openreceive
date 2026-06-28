import {
  cloneInvoiceStorageRow,
  type InvoiceStorageRow
} from "../storage/index.ts";
import {
  cloneStoredRecord,
  type StoredRecord
} from "../storage/kv.ts";

export function applySettled(
  record: StoredRecord,
  settledAt?: number
): StoredRecord {
  return updateRow(record, (row) => {
    if (row.transaction_state !== "settled") {
      row.transaction_state = "settled";
      if (row.workflow_state !== "settlement_action_completed") {
        row.workflow_state = "settlement_action_pending";
      }
    }
    if (row.settled_at === undefined && settledAt !== undefined) {
      row.settled_at = settledAt;
    }
  });
}

export function applyExpiredClosed(record: StoredRecord): StoredRecord {
  return updateRow(record, (row) => {
    if (row.transaction_state !== "settled") {
      row.transaction_state = "expired";
      row.workflow_state = "expired_closed";
    }
  });
}

export function applyFailedClosed(record: StoredRecord): StoredRecord {
  return updateRow(record, (row) => {
    if (row.transaction_state !== "settled") {
      row.transaction_state = "failed";
      row.workflow_state = "failed_closed";
    }
  });
}

export function applyVerifying(record: StoredRecord): StoredRecord {
  return updateRow(record, (row) => {
    if (
      row.transaction_state !== "settled" &&
      (
        row.workflow_state === "invoice_created" ||
        row.workflow_state === "expiry_pending_verification"
      )
    ) {
      row.workflow_state = "verifying";
    }
  });
}

export function applyExpiryPendingVerification(record: StoredRecord): StoredRecord {
  return updateRow(record, (row) => {
    if (
      row.transaction_state !== "settled" &&
      row.transaction_state !== "expired" &&
      row.transaction_state !== "failed"
    ) {
      row.workflow_state = "expiry_pending_verification";
    }
  });
}

export function markTransactionScanAttempted(
  record: StoredRecord,
  now: number
): StoredRecord {
  return updateRow(record, (row) => {
    row.last_transaction_scan_at = now;
  });
}

export function claimSettlementAction(
  record: StoredRecord,
  now: number
): StoredRecord {
  return updateRow(record, (row) => {
    row.workflow_state = "settlement_action_pending";
    row.settlement_action_state = "pending";
    row.action_claimed_at = now;
  });
}

export function clearSettlementActionClaim(record: StoredRecord): StoredRecord {
  return updateRow(record, (row) => {
    row.workflow_state = "settlement_action_pending";
    row.settlement_action_state = "failed";
    delete row.action_claimed_at;
  });
}

export function applySettlementActionCompleted(
  record: StoredRecord,
  at: number
): StoredRecord {
  return updateRow(record, (row) => {
    row.workflow_state = "settlement_action_completed";
    row.settlement_action_state = "completed";
    delete row.action_claimed_at;
    if (row.settlement_action_completed_at === undefined) {
      row.settlement_action_completed_at = at;
    }
  });
}

function updateRow(
  record: StoredRecord,
  update: (row: InvoiceStorageRow) => void
): StoredRecord {
  const next = cloneStoredRecord(record);
  next.rev = record.rev + 1;
  next.row = cloneInvoiceStorageRow(record.row);
  update(next.row);
  return next;
}
