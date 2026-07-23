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
  swapData?: unknown | null;
}): OpenReceivePaymentRecord {
  return {
    orderId: String(row.orderId),
    paymentHash: row.paymentHash,
    paidAt: row.paidAt ? Math.floor(row.paidAt.getTime() / 1000) : null,
    expiresAt: Math.floor(row.expiresAt.getTime() / 1000),
    createdAt: Math.floor(row.createdAt.getTime() / 1000),
    ...(row.swapData === undefined || row.swapData === null
      ? {}
      : { swapData: row.swapData as never }),
  };
}
`;
}

export function hooksStubContents(): string {
  return `import { createOpenReceivePaymentHooks } from "@openreceive/http";
import { createOpenReceivePaymentsRepository } from "./payments-repository.ts";

/**
 * Wire host order loading and trusted price resolution, then pass the returned
 * hooks to your Express/Fastify/Next adapter.
 */
export function createHostPaymentHooks(db: never) {
  return createOpenReceivePaymentHooks({
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
    payments: createOpenReceivePaymentsRepository(db),
  });
}
`;
}
