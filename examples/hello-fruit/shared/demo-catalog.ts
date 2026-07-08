import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HelloFruitFiatAmount } from "./demo-formatting.ts";

export interface HelloFruitProduct {
  readonly id: string;
  readonly name: string;
  readonly sticker: string;
  readonly fiat: HelloFruitFiatAmount;
}

const sharedRoot = path.dirname(fileURLToPath(import.meta.url));

/**
 * Reads the demo product catalog and enforces that every product declares a
 * fiat currency and price. Production catalogs sourced by other means must meet
 * the same requirement; currency is a property of each product, not the
 * environment.
 */
export function readHelloFruitCatalog(): readonly HelloFruitProduct[] {
  const raw: unknown = JSON.parse(
    readFileSync(path.join(sharedRoot, "fruits.json"), "utf8")
  );
  const fruits = (raw as { fruits?: unknown }).fruits;
  if (!Array.isArray(fruits) || fruits.length === 0) {
    throw new Error("Hello Fruit catalog requires at least one product.");
  }
  return fruits.map(assertHelloFruitProduct);
}

function assertHelloFruitProduct(value: unknown, index: number): HelloFruitProduct {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Hello Fruit product at index ${index} must be an object.`);
  }
  const product = value as Record<string, unknown>;
  const fiat = product.fiat;
  if (typeof fiat !== "object" || fiat === null) {
    throw new Error(
      `Hello Fruit product "${String(product.id ?? index)}" must declare a fiat price.`
    );
  }
  const { currency, value: amount } = fiat as Record<string, unknown>;
  if (typeof currency !== "string" || currency.trim().length === 0) {
    throw new Error(
      `Hello Fruit product "${String(product.id ?? index)}" must declare a fiat currency.`
    );
  }
  if (typeof amount !== "string" || amount.trim().length === 0) {
    throw new Error(
      `Hello Fruit product "${String(product.id ?? index)}" must declare a fiat price value.`
    );
  }
  return {
    id: String(product.id),
    name: String(product.name),
    sticker: String(product.sticker),
    fiat: { currency, value: amount }
  };
}
