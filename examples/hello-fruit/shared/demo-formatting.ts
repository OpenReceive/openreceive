import { HELLO_FRUIT_FIAT_FRACTION_DIGITS } from "./demo-currencies.ts";

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
  createOrderError: "Could not create order.",
} as const;

export function formatHelloFruitFiat(fiat: HelloFruitFiatAmount): string {
  const value = padHelloFruitFiatValue(fiat.value, fiat.currency);
  if (fiat.currency === "USD") return `$${value}`;
  if (fiat.currency === "BTC") return `${value} BTC`;
  if (fiat.currency === "SATS") return `${value} sats`;
  return `${value} ${fiat.currency}`;
}

/** Pads a decimal string to the currency's minor-unit width ("2" -> "2.00"). */
function padHelloFruitFiatValue(value: string, currency: string): string {
  const digits = HELLO_FRUIT_FIAT_FRACTION_DIGITS[currency.toUpperCase()];
  if (digits === undefined || digits <= 0 || !/^\d+(?:\.\d+)?$/.test(value)) return value;
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length >= digits) return value;
  return `${whole}.${fraction.padEnd(digits, "0")}`;
}

export function formatHelloFruitBuyNowLabel(fiat: HelloFruitFiatAmount): string {
  return `Add to cart (${formatHelloFruitFiat(fiat)})`;
}

export interface HelloFruitStickerModalCopy {
  readonly title: string;
  readonly detail: string;
}

/** Post-payment modal copy, shared so every variant says the same thing about a multi-item cart. */
export function helloFruitStickerModalCopy(
  stickers: readonly { readonly name: string; readonly quantity: number }[],
): HelloFruitStickerModalCopy {
  const total = stickers.reduce((sum, sticker) => sum + sticker.quantity, 0);
  if (total === 1) {
    return {
      title: "You just got a sticker",
      detail: `${stickers[0]?.name ?? "Sticker"} is ready.`,
    };
  }
  return { title: "Your stickers are ready", detail: `${total} stickers are ready.` };
}

export function createHelloFruitOrderInvoiceDescription(
  itemNames: readonly string[],
  input: {
    readonly demoName?: string;
  } = {},
): string {
  const demoLabel = input.demoName === undefined ? "demo" : `${input.demoName} demo`;
  return `Fruit stickers from OpenReceive ${demoLabel}: ${itemNames.join(", ")}`;
}
