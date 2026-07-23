/**
 * Server-only Hello Fruit order pricing. Do not import from browser clients.
 */

import { randomUUID } from "node:crypto";
import type { OpenReceive } from "@openreceive/node";
import { hostError, OpenReceiveHostError } from "@openreceive/http";
import {
  createHelloFruitOrderInvoiceDescription,
  type HelloFruitFiatAmount,
} from "./demo-formatting.ts";
import { readHelloFruitCatalog, type HelloFruitProduct } from "./demo-catalog.ts";
import {
  HELLO_FRUIT_DIRECT_AMOUNT_CURRENCIES,
  isHelloFruitDirectAmountCurrency,
  normalizeHelloFruitCurrency,
} from "./demo-currencies.ts";
import type {
  HelloFruitCartItemInput,
  HelloFruitCreateOrderInput,
  HelloFruitDemoOrder,
  HelloFruitOrderItem,
} from "./demo-order.ts";
import { readHelloFruitOrderRates } from "./demo-price-feeds.ts";
import type { HelloFruitBtcFiatRates } from "./demo-pricing.ts";
import {
  convertHelloFruitUsdAmount,
  multiplyHelloFruitAmount,
  sumHelloFruitAmounts,
} from "./demo-pricing.ts";

export interface HelloFruitCreateOrderResult {
  readonly order: HelloFruitDemoOrder;
  readonly invoiceRequest: {
    readonly orderId: string;
    readonly amount:
      | { readonly sats: string }
      | { readonly currency: string; readonly value: string };
    readonly memo: string;
  };
}

/** @deprecated Prefer {@link OpenReceiveHostError} / {@link hostError} from `@openreceive/http`. */
export class HelloFruitDemoOrderError extends OpenReceiveHostError {
  constructor(message: string, status = 400) {
    super(status, {
      code: "INVALID_REQUEST",
      message,
      retryable: false,
    });
    this.name = "HelloFruitDemoOrderError";
  }
}

export async function createHelloFruitCreateOrderResult(
  input: HelloFruitCreateOrderInput,
  options: {
    readonly demoId: string;
    readonly openreceive: Pick<OpenReceive, "listRates" | "priceCurrencies">;
    readonly demoName?: string;
    readonly catalog?: readonly HelloFruitProduct[];
  },
): Promise<HelloFruitCreateOrderResult> {
  const supportedCurrencies = [
    ...options.openreceive.priceCurrencies,
    ...HELLO_FRUIT_DIRECT_AMOUNT_CURRENCIES,
  ];
  const currency = normalizeHelloFruitCurrency(input.currency, [...supportedCurrencies]);
  const rates = await readHelloFruitOrderRates({
    currency,
    listRates: (currencies) => options.openreceive.listRates({ currencies }),
    supportedCurrencies,
  });
  const items = createHelloFruitOrderItems(
    input.cart,
    options.catalog ?? readHelloFruitCatalog(),
    currency,
    rates,
  );
  const total_amount = totalHelloFruitAmount(items);
  const uuid = createHelloFruitOrderId(options.demoId);
  const order: HelloFruitDemoOrder = {
    uuid,
    status: "pending_payment",
    items,
    total_amount,
  };
  const amount = createOpenReceiveCheckoutAmount(total_amount, currency);

  return {
    order,
    invoiceRequest: {
      orderId: uuid,
      amount,
      memo: createHelloFruitOrderInvoiceDescription(
        items.map((item) => `${item.name} x${item.quantity}`),
        { demoName: options.demoName },
      ),
    },
  };
}

function createOpenReceiveCheckoutAmount(
  total_amount: HelloFruitFiatAmount,
  currency: string,
): HelloFruitCreateOrderResult["invoiceRequest"]["amount"] {
  if (!isHelloFruitDirectAmountCurrency(currency)) {
    return { currency: total_amount.currency, value: total_amount.value };
  }
  if (currency === "BTC") {
    return { currency: "BTC", value: total_amount.value };
  }
  return { sats: total_amount.value };
}

function createHelloFruitOrderItems(
  cart: unknown,
  catalog: readonly HelloFruitProduct[],
  currency: string,
  rates: HelloFruitBtcFiatRates | undefined,
): HelloFruitOrderItem[] {
  if (!Array.isArray(cart) || cart.length === 0) {
    throw hostError("Cart must include at least one item.");
  }
  if (cart.length > 12) {
    throw hostError("Cart can include at most 12 items.");
  }

  const products = new Map(catalog.map((product) => [product.id, product]));
  const quantities = new Map<string, number>();
  for (const value of cart) {
    const item = asCartItem(value);
    const productId = requireProductId(item);
    const quantity = requireQuantity(item.quantity);
    if (!products.has(productId)) {
      throw hostError(`Unknown product: ${productId}.`);
    }
    quantities.set(productId, (quantities.get(productId) ?? 0) + quantity);
  }

  return [...quantities.entries()].map(([productId, quantity]) => {
    const product = products.get(productId);
    if (product === undefined) {
      throw hostError(`Unknown product: ${productId}.`);
    }
    const unit_amount = convertHelloFruitUsdAmount(product.fiat, currency, rates);
    return {
      product_id: productId,
      name: product.name,
      sticker: product.sticker,
      quantity,
      unit_amount,
      line_amount: multiplyHelloFruitAmount(unit_amount, quantity),
    };
  });
}

function totalHelloFruitAmount(items: readonly HelloFruitOrderItem[]): HelloFruitFiatAmount {
  return sumHelloFruitAmounts(items.map((item) => item.line_amount));
}

function createHelloFruitOrderId(demoId: string): string {
  return `${demoId}_${randomUUID().replaceAll("-", "")}`;
}

function asCartItem(value: unknown): HelloFruitCartItemInput {
  if (typeof value !== "object" || value === null) {
    throw hostError("Cart items must be objects.");
  }
  return value as HelloFruitCartItemInput;
}

function requireProductId(item: HelloFruitCartItemInput): string {
  const productId =
    typeof item.product_id === "string"
      ? item.product_id
      : typeof item.id === "string"
        ? item.id
        : "";
  if (productId.length === 0) {
    throw hostError("Cart items require a product_id.");
  }
  return productId;
}

function requireQuantity(value: unknown): number {
  const quantity = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
    throw hostError("Cart item quantity must be an integer from 1 to 99.");
  }
  return quantity;
}
