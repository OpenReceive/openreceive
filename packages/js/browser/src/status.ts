import { type TransactionSettlementStatus, unixSeconds } from "@openreceive/core";

/** The payer-facing status: exactly {@link TransactionSettlementStatus}, derived from the server's verdict and the expiry clock. */
export type Status = TransactionSettlementStatus;

export interface StatusInvoiceLike {
  readonly transaction_state?: string;
  readonly expires_at?: number | string | null;
}

export function status(
  invoice: StatusInvoiceLike,
  options: { readonly now?: number } = {},
): Status {
  // transaction_state is the server's verdict, computed from the settlement
  // rule in @openreceive/core. The browser never re-derives "settled" from
  // settled_at: one rule, one owner.
  if (invoice.transaction_state === "settled") return "settled";
  if (invoice.transaction_state === "failed") return "failed";
  if (invoice.transaction_state === "expired") return "expired";

  const expiresAt = readUnixSeconds(invoice.expires_at);
  if (expiresAt !== undefined && expiresAt <= (options.now ?? unixSeconds())) {
    return "expired";
  }

  return "pending";
}

function readUnixSeconds(value: number | string | null | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim().length === 0) return undefined;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
