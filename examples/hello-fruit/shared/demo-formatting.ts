export interface HelloFruitFiatAmount {
  readonly currency: string;
  readonly value: string;
}

export const helloFruitDemoLabels = {
  createInvoice: "Create invoice",
  creatingInvoice: "Creating invoice...",
  createInvoiceError: "Could not create invoice."
} as const;

export function formatHelloFruitFiat(fiat: HelloFruitFiatAmount): string {
  return fiat.currency === "USD" ? `$${fiat.value}` : `${fiat.value} ${fiat.currency}`;
}

export function formatHelloFruitBuyNowLabel(fiat: HelloFruitFiatAmount): string {
  return `Buy Now (${formatHelloFruitFiat(fiat)})`;
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
