/** Shared TypeScript helpers embedded in every ORM scaffold. */
export function attemptConflictClass(): string {
  return `export class OpenReceiveAttemptConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenReceiveAttemptConflict";
  }
}
`;
}

export function recordMapperHelper(): string {
  return `function toPaymentRecord(row: {
  orderId: string | number;
  paymentHash: string;
  paidAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  checkoutData: unknown;
  swapData?: unknown | null;
}): OpenReceivePaymentRecord {
  return {
    orderId: String(row.orderId),
    paymentHash: row.paymentHash,
    paidAt: row.paidAt ? Math.floor(row.paidAt.getTime() / 1000) : null,
    expiresAt: Math.floor(row.expiresAt.getTime() / 1000),
    createdAt: Math.floor(row.createdAt.getTime() / 1000),
    checkout: row.checkoutData as OpenReceivePaymentRecord["checkout"],
    ...(row.swapData === undefined || row.swapData === null
      ? {}
      : { swapData: row.swapData as never }),
  };
}
`;
}

export function hostStubContents(): string {
  return `import {
  createOpenReceiveHost as buildOpenReceiveHost,
  type OpenReceiveHostRepository,
} from "@openreceive/http";
import { markOpenReceivePaidOnce } from "./mark-paid-once.ts";
import { createOpenReceivePaymentsRepository } from "./payments-repository.ts";

/**
 * Finish the two TODOs below once, then import this integration from app boot.
 * onFirstSettlement runs inside the same transaction that records paid_at:
 * update the host order or insert an outbox job there.
 */
export function createOpenReceiveHost(
  db: never,
  onFirstSettlement: (
    transaction: unknown,
    settled: { orderId: string; paymentHash: string },
  ) => Promise<void>,
) {
  const payments = createOpenReceivePaymentsRepository(db) as OpenReceiveHostRepository;
  return buildOpenReceiveHost({
    async loadOrder(orderId) {
      // TODO: load the host order by id. Return null to produce 404.
      void orderId;
      void db;
      return null;
    },
    amountForOrder(order) {
      // TODO: return the trusted host amount, never a payer-supplied value.
      void order;
      return { currency: "USD", value: "0.00" };
    },
    payments,
    onPaid: (payment) =>
      markOpenReceivePaidOnce(db, payment, onFirstSettlement),
  });
}
`;
}
