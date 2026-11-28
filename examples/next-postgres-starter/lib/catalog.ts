// The shop and its one product. Prices are decimal strings: OpenReceive
// converts the order's own amount into the Lightning invoice and never reads a
// price from the browser.
export const shop = {
  name: "Lightning Sticker Shop",
} as const;

export const product = {
  id: "demo-sticker",
  name: "Demo sticker",
  description:
    "A sticker that never ships: this is a demo store. Payments are real bitcoin and go straight to the shop's wallet.",
  price: "5.00",
  currency: "USD",
} as const;

/** "$5.00" for a decimal-string amount. Intl formats the string exactly, with no float. */
export function formatPrice(amount: string, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    amount as `${number}`,
  );
}
