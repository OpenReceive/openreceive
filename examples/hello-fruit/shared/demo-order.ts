import {
  createHelloFruitOrderInvoiceDescription,
  type HelloFruitFiatAmount
} from "./demo-formatting.ts";
import {
  readHelloFruitCatalog,
  type HelloFruitProduct
} from "./demo-catalog.ts";
import {
  isHelloFruitDirectAmountCurrency,
  normalizeHelloFruitCurrency,
  readHelloFruitCheckoutCurrencies
} from "./demo-currencies.ts";

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
  readonly unitAmount: HelloFruitFiatAmount;
  readonly lineAmount: HelloFruitFiatAmount;
}

export interface HelloFruitDemoOrder {
  readonly uuid: string;
  readonly status: "pending_payment" | "paid";
  readonly items: readonly HelloFruitOrderItem[];
  readonly totalAmount: HelloFruitFiatAmount;
}

export interface HelloFruitCreateOrderResult {
  readonly order: HelloFruitDemoOrder;
  readonly invoiceRequest: {
    readonly orderId: string;
    readonly amount:
      | {
        readonly btc: {
          readonly currency: "BTC";
          readonly value: string;
        };
      }
      | { readonly sats: string }
      | { readonly fiat: HelloFruitFiatAmount };
    readonly memo: string;
    readonly expiresInSeconds: number;
  };
}

export interface HelloFruitBtcFiatRates {
  readonly bitcoin: Readonly<Record<string, string>>;
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
    readonly rates?: HelloFruitBtcFiatRates;
    readonly supportedCurrencies?: readonly string[];
  }
): HelloFruitCreateOrderResult {
  const idempotencyKey = requireIdempotencyKey(input.idempotency_key);
  const supportedCurrencies = options.supportedCurrencies ?? readHelloFruitCheckoutCurrencies();
  const currency = normalizeHelloFruitCurrency(input.currency, [...supportedCurrencies]);
  const items = createHelloFruitOrderItems(
    input.cart,
    options.catalog ?? readHelloFruitCatalog(),
    currency,
    options.rates
  );
  const totalAmount = totalHelloFruitAmount(items);
  const uuid = `hello-fruit-${options.demoId}-${idempotencyKey}`;
  const order: HelloFruitDemoOrder = {
    uuid,
    status: "pending_payment",
    items,
    totalAmount
  };
  const amount = createOpenReceiveCheckoutAmount(totalAmount, currency);

  return {
    order,
    invoiceRequest: {
      orderId: uuid,
      amount,
      memo: createHelloFruitOrderInvoiceDescription(
        items.map((item) => `${item.name} x${item.quantity}`),
        { demoName: options.demoName }
      ),
      expiresInSeconds: options.invoiceExpirySeconds
    }
  };
}

function createOpenReceiveCheckoutAmount(
  totalAmount: HelloFruitFiatAmount,
  currency: string
): HelloFruitCreateOrderResult["invoiceRequest"]["amount"] {
  if (!isHelloFruitDirectAmountCurrency(currency)) {
    return { fiat: totalAmount };
  }
  if (currency === "BTC") {
    return {
      btc: {
        currency,
        value: totalAmount.value
      }
    };
  }
  return { sats: totalAmount.value };
}

export function createHelloFruitOrderStatus(input: {
  readonly orderId?: unknown;
  readonly order_id?: unknown;
  readonly paid?: unknown;
  readonly status?: unknown;
  readonly paidAt?: unknown;
  readonly settled_at?: unknown;
  readonly transaction_state?: unknown;
  readonly state?: unknown;
}): HelloFruitOrderStatus {
  const orderId =
    typeof input.orderId === "string" && input.orderId.length > 0
      ? input.orderId
      : typeof input.order_id === "string" && input.order_id.length > 0
      ? input.order_id
      : "unknown";
  const paid = input.paid === true ||
    input.status === "paid" ||
    typeof input.paidAt === "number" ||
    typeof input.settled_at === "number" ||
    input.transaction_state === "settled" ||
    input.state === "settled";

  return {
    order_id: orderId,
    order_status: paid ? "paid" : "pending_payment"
  };
}

function createHelloFruitOrderItems(
  cart: unknown,
  catalog: readonly HelloFruitProduct[],
  currency: string,
  rates: HelloFruitBtcFiatRates | undefined
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
    const unitAmount = convertHelloFruitUsdAmount(product.fiat, currency, rates);
    return {
      product_id: product.id,
      name: product.name,
      sticker: product.sticker,
      quantity,
      unitAmount,
      lineAmount: multiplyAmount(unitAmount, quantity)
    };
  });
}

function totalHelloFruitAmount(items: readonly HelloFruitOrderItem[]): HelloFruitFiatAmount {
  const first = items[0];
  if (first === undefined) {
    throw new HelloFruitDemoOrderError("Cart must include at least one item.");
  }
  const currency = first.unitAmount.currency;
  let scale = 0;
  let totalUnits = 0n;

  for (const item of items) {
    if (item.unitAmount.currency !== currency) {
      throw new HelloFruitDemoOrderError("Cart items must use one currency.");
    }
    const decimal = parseDecimal(item.lineAmount.value);
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

function multiplyAmount(fiat: HelloFruitFiatAmount, quantity: number): HelloFruitFiatAmount {
  const decimal = parseDecimal(fiat.value);
  return {
    currency: fiat.currency,
    value: formatDecimal(decimal.units * BigInt(quantity), decimal.scale)
  };
}

function convertHelloFruitUsdAmount(
  amount: HelloFruitFiatAmount,
  currency: string,
  rates: HelloFruitBtcFiatRates | undefined
): HelloFruitFiatAmount {
  if (amount.currency !== "USD") {
    throw new HelloFruitDemoOrderError("Hello Fruit catalog prices must use USD as the base currency.");
  }
  if (currency === "USD") return amount;

  const usdRate = requiredRate(rates, "USD");
  if (currency === "BTC" || currency === "SATS") {
    const sats = usdToSats(amount.value, usdRate);
    return {
      currency,
      value: currency === "BTC" ? formatBtcFromSats(sats) : sats.toString()
    };
  }

  const targetRate = requiredRate(rates, currency);
  return {
    currency,
    value: convertUsdToFiat(amount.value, usdRate, targetRate)
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

function requiredRate(
  rates: HelloFruitBtcFiatRates | undefined,
  currency: string
): string {
  const rate = rates?.bitcoin[currency.toLowerCase()];
  if (rate === undefined) {
    throw new HelloFruitDemoOrderError(`Missing BTC/${currency} price feed rate.`, 503);
  }
  return rate;
}

function usdToSats(usdValue: string, usdBtcPrice: string): bigint {
  const usd = parseDecimal(usdValue);
  const price = parseDecimal(usdBtcPrice);
  if (price.units <= 0n) {
    throw new HelloFruitDemoOrderError("BTC/USD price feed rate must be greater than zero.", 503);
  }
  const numerator = usd.units * BigInt(price.scale) * 100_000_000n;
  const denominator = price.units * BigInt(usd.scale);
  return ceilDiv(numerator, denominator);
}

function convertUsdToFiat(
  usdValue: string,
  usdBtcPrice: string,
  targetBtcPrice: string
): string {
  const usd = parseDecimal(usdValue);
  const usdPrice = parseDecimal(usdBtcPrice);
  const targetPrice = parseDecimal(targetBtcPrice);
  if (usdPrice.units <= 0n || targetPrice.units <= 0n) {
    throw new HelloFruitDemoOrderError("BTC fiat price feed rates must be greater than zero.", 503);
  }

  const scale = 2;
  const outputScale = 10n ** BigInt(scale);
  const numerator = usd.units * targetPrice.units * BigInt(usdPrice.scale) * outputScale;
  const denominator = BigInt(usd.scale) * BigInt(targetPrice.scale) * usdPrice.units;
  return formatDecimal(ceilDiv(numerator, denominator), scale);
}

function formatBtcFromSats(sats: bigint): string {
  return formatDecimal(sats, 8).replace(/0+$/, "").replace(/\.$/, "");
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
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
