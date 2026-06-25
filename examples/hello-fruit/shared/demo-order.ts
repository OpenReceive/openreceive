import {
  createHelloFruitOrderInvoiceDescription,
  type HelloFruitFiatAmount
} from "./demo-formatting.ts";
import {
  readHelloFruitCatalog,
  type HelloFruitProduct
} from "./demo-catalog.ts";

export interface HelloFruitCartItemInput {
  readonly id?: unknown;
  readonly product_id?: unknown;
  readonly quantity?: unknown;
}

export interface HelloFruitCreateOrderInput {
  readonly cart?: unknown;
  readonly idempotency_key?: unknown;
}

export interface HelloFruitOrderItem {
  readonly product_id: string;
  readonly name: string;
  readonly sticker: string;
  readonly quantity: number;
  readonly unitFiat: HelloFruitFiatAmount;
  readonly lineFiat: HelloFruitFiatAmount;
}

export interface HelloFruitDemoOrder {
  readonly uuid: string;
  readonly status: "pending_payment" | "paid";
  readonly items: readonly HelloFruitOrderItem[];
  readonly totalFiat: HelloFruitFiatAmount;
}

export interface HelloFruitCreateOrderResult {
  readonly order: HelloFruitDemoOrder;
  readonly invoiceRequest: {
    readonly orderUuid: string;
    readonly fiat: HelloFruitFiatAmount;
    readonly optionalInvoiceDescription: string;
    readonly expiry: number;
  };
}

export interface HelloFruitOrderStatus {
  readonly order_uuid: string;
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
      retryable: false
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
  }
): HelloFruitCreateOrderResult {
  const idempotencyKey = requireIdempotencyKey(input.idempotency_key);
  const items = createHelloFruitOrderItems(input.cart, options.catalog ?? readHelloFruitCatalog());
  const totalFiat = totalHelloFruitFiat(items);
  const uuid = `hello-fruit-${options.demoId}-${idempotencyKey}`;
  const order: HelloFruitDemoOrder = {
    uuid,
    status: "pending_payment",
    items,
    totalFiat
  };

  return {
    order,
    invoiceRequest: {
      orderUuid: uuid,
      fiat: totalFiat,
      optionalInvoiceDescription: createHelloFruitOrderInvoiceDescription(
        items.map((item) => `${item.name} x${item.quantity}`),
        { demoName: options.demoName }
      ),
      expiry: options.invoiceExpirySeconds
    }
  };
}

export function createHelloFruitOrderStatus(input: {
  readonly order_uuid?: unknown;
  readonly settled_at?: unknown;
  readonly transaction_state?: unknown;
  readonly state?: unknown;
}): HelloFruitOrderStatus {
  const orderUuid = typeof input.order_uuid === "string" && input.order_uuid.length > 0
    ? input.order_uuid
    : "unknown";
  const paid = typeof input.settled_at === "number" ||
    input.transaction_state === "settled" ||
    input.state === "settled";

  return {
    order_uuid: orderUuid,
    order_status: paid ? "paid" : "pending_payment"
  };
}

function createHelloFruitOrderItems(
  cart: unknown,
  catalog: readonly HelloFruitProduct[]
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
    return {
      product_id: product.id,
      name: product.name,
      sticker: product.sticker,
      quantity,
      unitFiat: product.fiat,
      lineFiat: multiplyFiat(product.fiat, quantity)
    };
  });
}

function totalHelloFruitFiat(items: readonly HelloFruitOrderItem[]): HelloFruitFiatAmount {
  const first = items[0];
  if (first === undefined) {
    throw new HelloFruitDemoOrderError("Cart must include at least one item.");
  }
  const currency = first.unitFiat.currency;
  let scale = 0;
  let totalUnits = 0n;

  for (const item of items) {
    if (item.unitFiat.currency !== currency) {
      throw new HelloFruitDemoOrderError("Cart items must use one currency.");
    }
    const decimal = parseDecimal(item.lineFiat.value);
    if (decimal.scale > scale) {
      totalUnits *= 10n ** BigInt(decimal.scale - scale);
      scale = decimal.scale;
    }
    totalUnits += decimal.units * (10n ** BigInt(scale - decimal.scale));
  }

  return {
    currency,
    value: formatDecimal(totalUnits, scale)
  };
}

function multiplyFiat(fiat: HelloFruitFiatAmount, quantity: number): HelloFruitFiatAmount {
  const decimal = parseDecimal(fiat.value);
  return {
    currency: fiat.currency,
    value: formatDecimal(decimal.units * BigInt(quantity), decimal.scale)
  };
}

function parseDecimal(value: string): { readonly units: bigint; readonly scale: number } {
  if (!/^\d+(?:\.\d+)?$/.test(value)) {
    throw new HelloFruitDemoOrderError("Fiat prices must be positive decimal strings.");
  }
  const [integer, fraction = ""] = value.split(".");
  return {
    units: BigInt(`${integer}${fraction}`),
    scale: fraction.length
  };
}

function formatDecimal(units: bigint, scale: number): string {
  if (scale === 0) return units.toString();
  const raw = units.toString().padStart(scale + 1, "0");
  const integer = raw.slice(0, -scale);
  const fraction = raw.slice(-scale);
  return `${integer}.${fraction}`;
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

function requireIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HelloFruitDemoOrderError("idempotency_key is required.");
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new HelloFruitDemoOrderError("idempotency_key must be a URL-safe identifier.");
  }
  return value;
}
