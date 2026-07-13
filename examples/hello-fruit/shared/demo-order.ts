/**
 * Browser-safe Hello Fruit order display types and guards.
 * Server prepare/pricing lives in `demo-prepare-checkout.ts` (do not import that from clients).
 */

export interface HelloFruitCartItemInput {
  readonly id?: unknown;
  readonly product_id?: unknown;
  readonly quantity?: unknown;
}

export interface HelloFruitCreateOrderInput {
  readonly cart?: unknown;
  readonly currency?: unknown;
}

export interface HelloFruitOrderItem {
  readonly product_id: string;
  readonly name: string;
  readonly sticker: string;
  readonly quantity: number;
  readonly unit_amount: {
    readonly currency: string;
    readonly value: string;
  };
  readonly line_amount: {
    readonly currency: string;
    readonly value: string;
  };
}

export interface HelloFruitDemoOrder {
  readonly uuid: string;
  readonly status: "pending_payment" | "paid";
  readonly items: readonly HelloFruitOrderItem[];
  readonly total_amount: {
    readonly currency: string;
    readonly value: string;
  };
}

export function isHelloFruitDemoOrder(value: unknown): value is HelloFruitDemoOrder {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.uuid === "string" &&
    (record.status === "pending_payment" || record.status === "paid") &&
    Array.isArray(record.items) &&
    typeof record.total_amount === "object" &&
    record.total_amount !== null
  );
}
