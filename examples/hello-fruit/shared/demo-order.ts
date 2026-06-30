import {
  createHelloFruitOrderInvoiceDescription,
  type HelloFruitFiatAmount,
} from "./demo-formatting.ts";
import {
  readHelloFruitCatalog,
  type HelloFruitProduct,
} from "./demo-catalog.ts";
import {
  isHelloFruitDirectAmountCurrency,
  normalizeHelloFruitCurrency,
  readHelloFruitCheckoutCurrencies,
} from "./demo-currencies.ts";
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
  readonly idempotency_key?: unknown;
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
      | {
          readonly btc: {
            readonly currency: "BTC" | "SATS";
            readonly value: string;
          };
        }
      | { readonly fiat: HelloFruitFiatAmount };
    readonly memo: string;
    readonly expiresInSeconds: number;
  };
}

export interface HelloFruitOrderStatus {
  readonly order_id: string;
  readonly order_status: "pending_payment" | "paid";
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

export function createHelloFruitCreateOrderResult(
  input: HelloFruitCreateOrderInput,
  options: {
    readonly demoId: string;
    readonly invoiceExpirySeconds: number;
    readonly demoName?: string;
    readonly catalog?: readonly HelloFruitProduct[];
    readonly rates?: HelloFruitBtcFiatRates;
    readonly supportedCurrencies?: readonly string[];
  },
): HelloFruitCreateOrderResult {
  const idempotencyKey = requireIdempotencyKey(input.idempotency_key);
  const supportedCurrencies =
    options.supportedCurrencies ?? readHelloFruitCheckoutCurrencies();
  const currency = normalizeHelloFruitCurrency(input.currency, [
    ...supportedCurrencies,
  ]);
  const items = createHelloFruitOrderItems(
    input.cart,
    options.catalog ?? readHelloFruitCatalog(),
    currency,
    options.rates,
  );
  const total_amount = totalHelloFruitAmount(items);
  const uuid = `hello-fruit-${options.demoId}-${idempotencyKey}`;
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
      expiresInSeconds: options.invoiceExpirySeconds,
    },
  };
}

function createOpenReceiveCheckoutAmount(
  total_amount: HelloFruitFiatAmount,
  currency: string,
): HelloFruitCreateOrderResult["invoiceRequest"]["amount"] {
  if (!isHelloFruitDirectAmountCurrency(currency)) {
    return { fiat: total_amount };
  }
  if (currency === "BTC") {
    return {
      btc: {
        currency,
        value: total_amount.value,
      },
    };
  }
  return {
    btc: {
      currency: "SATS",
      value: total_amount.value,
    },
  };
}

export function createHelloFruitOrderStatus(input: {
  readonly order_id?: unknown;
  readonly paid?: unknown;
  readonly status?: unknown;
  readonly paid_at?: unknown;
  readonly settled_at?: unknown;
  readonly transaction_state?: unknown;
  readonly state?: unknown;
}): HelloFruitOrderStatus {
  const orderId =
    typeof input.order_id === "string" && input.order_id.length > 0
      ? input.order_id
      : "unknown";
  const paid =
    input.paid === true ||
    input.status === "paid" ||
    typeof input.paid_at === "number" ||
    typeof input.settled_at === "number" ||
    input.transaction_state === "settled" ||
    input.state === "settled";

  return {
    order_id: orderId,
    order_status: paid ? "paid" : "pending_payment",
  };
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
      line_amount: withHelloFruitPricing(() =>
        multiplyHelloFruitAmount(unit_amount, quantity),
      ),
    };
  });
}

function totalHelloFruitAmount(
  items: readonly HelloFruitOrderItem[],
): HelloFruitFiatAmount {
  if (items.length === 0) {
    throw new HelloFruitDemoOrderError("Cart must include at least one item.");
  }
  return withHelloFruitPricing(() =>
    sumHelloFruitAmounts(items.map((item) => item.line_amount)),
  );
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
  const productId =
    typeof item.product_id === "string" ? item.product_id : item.id;
  if (typeof productId !== "string" || productId.length === 0) {
    throw new HelloFruitDemoOrderError("Cart items require product_id.");
  }
  return productId;
}

function requireQuantity(value: unknown): number {
  if (
    !Number.isInteger(value) ||
    typeof value !== "number" ||
    value < 1 ||
    value > 9
  ) {
    throw new HelloFruitDemoOrderError(
      "Cart item quantity must be an integer from 1 through 9.",
    );
  }
  return value;
}

function requireIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HelloFruitDemoOrderError("idempotency_key is required.");
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new HelloFruitDemoOrderError(
      "idempotency_key must be a URL-safe identifier.",
    );
  }
  return value;
}
