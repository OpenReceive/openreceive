// The shop's one product. Prices are decimal strings: OpenReceive converts the
// order's own amount into the Lightning invoice and never reads a price from
// the browser.
export const product = {
  id: "demo-sticker",
  name: "Demo sticker",
  price: "1.00",
  currency: "USD",
} as const;
