export interface HelloFruitFiatAmount {
  readonly currency: string;
  readonly value: string;
}

export interface HelloFruitDisplayAmount {
  readonly currency: string;
  readonly value: string;
}

export const helloFruitDemoLabels = {
  createOrder: "Create order",
  creatingOrder: "Creating order...",
  createOrderError: "Could not create order."
} as const;

export function formatHelloFruitFiat(fiat: HelloFruitFiatAmount): string {
  if (fiat.currency === "USD") return `$${fiat.value}`;
  if (fiat.currency === "BTC") return `${fiat.value} BTC`;
  if (fiat.currency === "SATS") return `${fiat.value} sats`;
  return `${fiat.value} ${fiat.currency}`;
}

export function formatHelloFruitBuyNowLabel(fiat: HelloFruitFiatAmount): string {
  return `Add to cart (${formatHelloFruitFiat(fiat)})`;
}

export function createHelloFruitInvoiceDescription(
  fruitName: string,
  input: {
    readonly demoName?: string;
  } = {}
): string {
  const demoLabel = input.demoName === undefined
    ? "demo"
    : `${input.demoName} demo`;
  return `Fruit sticker from OpenReceive ${demoLabel}: ${fruitName}`;
}

export function createHelloFruitOrderInvoiceDescription(
  itemNames: readonly string[],
  input: {
    readonly demoName?: string;
  } = {}
): string {
  const demoLabel = input.demoName === undefined
    ? "demo"
    : `${input.demoName} demo`;
  return `Fruit stickers from OpenReceive ${demoLabel}: ${itemNames.join(", ")}`;
}
