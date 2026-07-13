import { randomUUID } from "node:crypto";
import type { OpenReceive, CheckoutAmountSource } from "@openreceive/node";
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
import { readHelloFruitOrderRates } from "./demo-price-feeds.ts";
import {
  convertHelloFruitUsdAmount,
  HelloFruitPricingError,
  multiplyHelloFruitAmount,
  sumHelloFruitAmounts,
  type HelloFruitBtcFiatRates,
} from "./demo-pricing.ts";

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
  readonly unit_amount: HelloFruitFiatAmount;
  readonly line_amount: HelloFruitFiatAmount;
}

export interface HelloFruitDemoOrder {
  readonly uuid: string;
  readonly status: "pending_payment" | "paid";
  readonly items: readonly HelloFruitOrderItem[];
  readonly total_amount: HelloFruitFiatAmount;
}

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


/**
 * Meta-store key prefix under which the app persists each prepared order. Persisting through the
 * OpenReceive store's KV (not an in-memory Map) keeps the amount authority durable and correct
 * across multiple instances (Heroku/Vercel), which is the whole point of the shipped-router model:
 * `/prepare_order` writes the order here, and the mounted create-checkout route's `getCheckoutAmount`
 * reads it back. The create body never carries a client price.
 */
export const HELLO_FRUIT_ORDER_META_PREFIX = "demo_order:";

interface StoredHelloFruitOrder {
  readonly order: HelloFruitDemoOrder;
  readonly amount: HelloFruitCreateOrderResult["invoiceRequest"]["amount"];
}

/**
 * App order step (NOT an OpenReceive route): validate the cart, compute items + the authoritative
 * total, assign an order id, and PERSIST the order keyed by that id so `getCheckoutAmount` can look it
 * up later. Returns just `{ order }` for display — creating the checkout is the mounted router's job.
 */
export async function prepareHelloFruitOrder(
  input: HelloFruitCreateOrderInput,
  options: {
    readonly demoId: string;
    readonly openreceive: OpenReceive;
    readonly demoName?: string;
    readonly catalog?: readonly HelloFruitProduct[];
  },
): Promise<{ order: HelloFruitDemoOrder }> {
  const result = await createHelloFruitCreateOrderResult(input, options);
  const stored: StoredHelloFruitOrder = {
    order: result.order,
    amount: result.invoiceRequest.amount,
  };
  // casMeta(key, value, null) is insert-if-absent; the order id is a fresh UUID so it never conflicts.
  await options.openreceive.store.casMeta(
    `${HELLO_FRUIT_ORDER_META_PREFIX}${result.order.uuid}`,
    JSON.stringify(stored),
    null,
  );
  return { order: result.order };
}

/**
 * The amount authority for the mounted create-checkout route: look the persisted order up by id and
 * return its authoritative amount source. Returns `null` when the order is unknown (HTTP → 404).
 * The create body never carries a client price.
 */
export async function getHelloFruitCheckoutAmount(
  openreceive: Pick<OpenReceive, "store">,
  orderId: string,
): Promise<CheckoutAmountSource | null> {
  const stored = await readStoredHelloFruitOrder(openreceive, orderId);
  return stored === null ? null : { amount: stored.amount };
}

/**
 * Host display lookup for guest checkout resume (`GET /orders/:orderId`). Returns the public order
 * summary only — never OpenReceive capability tokens or amount-authority internals beyond what the
 * prepare response already showed the payer.
 */
export async function getHelloFruitDemoOrder(
  openreceive: Pick<OpenReceive, "store">,
  orderId: string,
): Promise<HelloFruitDemoOrder | null> {
  const stored = await readStoredHelloFruitOrder(openreceive, orderId);
  return stored === null ? null : stored.order;
}

async function readStoredHelloFruitOrder(
  openreceive: Pick<OpenReceive, "store">,
  orderId: string,
): Promise<StoredHelloFruitOrder | null> {
  const row = await openreceive.store.getMeta(`${HELLO_FRUIT_ORDER_META_PREFIX}${orderId}`);
  if (row === undefined) return null;
  return JSON.parse(row.value) as StoredHelloFruitOrder;
}

export class HelloFruitDemoOrderError extends Error {
  readonly status: number;
  readonly body: {
    readonly code: "INVALID_REQUEST";
    readonly message: string;
    readonly retryable: false;
  };

  constructor(message: string, status = 400) {
    super(message);
    this.name = "HelloFruitDemoOrderError";
    this.status = status;
    this.body = {
      code: "INVALID_REQUEST",
      message,
      retryable: false,
    };
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
    throw new HelloFruitDemoOrderError("Cart must include at least one item.");
  }
  if (cart.length > 12) {
    throw new HelloFruitDemoOrderError("Cart can include at most 12 items.");
  }

  const products = new Map(catalog.map((product) => [product.id, product]));
  const quantities = new Map<string, number>();
  for (const value of cart) {
    const item = asCartItem(value);
    const productId = requireProductId(item);
    const quantity = requireQuantity(item.quantity);
    if (!products.has(productId)) {
      throw new HelloFruitDemoOrderError(`Unknown product: ${productId}.`);
    }
    quantities.set(productId, (quantities.get(productId) ?? 0) + quantity);
  }

  return [...quantities.entries()].map(([productId, quantity]) => {
    const product = products.get(productId);
    if (product === undefined) {
      throw new HelloFruitDemoOrderError(`Unknown product: ${productId}.`);
    }
    const unit_amount = withHelloFruitPricing(() =>
      convertHelloFruitUsdAmount(product.fiat, currency, rates),
    );
    return {
      product_id: product.id,
      name: product.name,
      sticker: product.sticker,
      quantity,
      unit_amount,
      line_amount: withHelloFruitPricing(() => multiplyHelloFruitAmount(unit_amount, quantity)),
    };
  });
}

function totalHelloFruitAmount(items: readonly HelloFruitOrderItem[]): HelloFruitFiatAmount {
  if (items.length === 0) {
    throw new HelloFruitDemoOrderError("Cart must include at least one item.");
  }
  return withHelloFruitPricing(() => sumHelloFruitAmounts(items.map((item) => item.line_amount)));
}

function withHelloFruitPricing<T>(compute: () => T): T {
  try {
    return compute();
  } catch (error) {
    if (error instanceof HelloFruitPricingError) {
      throw new HelloFruitDemoOrderError(error.message, error.status);
    }
    throw error;
  }
}

function asCartItem(value: unknown): HelloFruitCartItemInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HelloFruitDemoOrderError("Cart items must be objects.");
  }
  return value as HelloFruitCartItemInput;
}

function requireProductId(item: HelloFruitCartItemInput): string {
  const productId = typeof item.product_id === "string" ? item.product_id : item.id;
  if (typeof productId !== "string" || productId.length === 0) {
    throw new HelloFruitDemoOrderError("Cart items require product_id.");
  }
  return productId;
}

function requireQuantity(value: unknown): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1 || value > 9) {
    throw new HelloFruitDemoOrderError("Cart item quantity must be an integer from 1 through 9.");
  }
  return value;
}

function createHelloFruitOrderId(demoId: string): string {
  return `hello-fruit-${demoId}-${randomUUID()}`;
}
