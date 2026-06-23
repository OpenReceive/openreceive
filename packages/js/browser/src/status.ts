export type Status = "pending" | "paid" | "expired" | "failed";

export interface StatusInvoiceLike {
  readonly transaction_state?: string;
  readonly settled_at?: number | string | null;
  readonly expires_at?: number | string | null;
}

export function status(
  invoice: StatusInvoiceLike,
  options: { readonly now?: number } = {}
): Status {
  if (invoice.transaction_state === "settled" || invoice.settled_at != null) {
    return "paid";
  }
  if (invoice.transaction_state === "failed") return "failed";
  if (invoice.transaction_state === "expired") return "expired";

  const expiresAt = readUnixSeconds(invoice.expires_at);
  if (expiresAt !== undefined && expiresAt <= (options.now ?? currentUnixSeconds())) {
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

function currentUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
