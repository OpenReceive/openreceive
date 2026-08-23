export const HELLO_FRUIT_DIRECT_AMOUNT_CURRENCIES = ["BTC", "SATS"] as const;

/**
 * Minor-unit widths for the fiat currencies the demos display, so totals
 * render as "2.00" instead of "2.0"/"2". This file is the canonical owner of
 * the demo currency data; the Rails demo mirrors it in
 * app/models/money_format.rb (MIN_FRACTION_DIGITS) and
 * app/models/create_fruit_order.rb (DIRECT_CURRENCIES/SUPPORTED), guarded by
 * examples/hello-fruit/server/rails/script/check-currency-drift.mjs.
 */
export const HELLO_FRUIT_FIAT_FRACTION_DIGITS: Readonly<Record<string, number>> = {
  USD: 2,
};

export type HelloFruitDirectAmountCurrency = (typeof HELLO_FRUIT_DIRECT_AMOUNT_CURRENCIES)[number];

export type HelloFruitCurrency = string;

/**
 * Currencies the Hello Fruit UI offers. Matches openreceive-config.ts (`USD`)
 * plus direct bitcoin units. Extra fiat belongs in the tracked
 * `priceCurrencies` setting — see docs/guides/price-feeds.md.
 */
export function readHelloFruitCheckoutCurrencies(): string[] {
  return ["USD", ...HELLO_FRUIT_DIRECT_AMOUNT_CURRENCIES];
}

export function isHelloFruitDirectAmountCurrency(
  currency: string,
): currency is HelloFruitDirectAmountCurrency {
  return (HELLO_FRUIT_DIRECT_AMOUNT_CURRENCIES as readonly string[]).includes(currency);
}

export function helloFruitOrderRateCurrencies(currency: string): string[] {
  if (currency === "USD") return [];
  if (isHelloFruitDirectAmountCurrency(currency)) return ["USD"];
  return ["USD", currency];
}

export function normalizeHelloFruitCurrency(
  value: unknown,
  supportedCurrencies = readHelloFruitCheckoutCurrencies(),
): string {
  const currency = typeof value === "string" && value.length > 0 ? value.toUpperCase() : "USD";
  if (!supportedCurrencies.includes(currency)) {
    throw new Error(`Unsupported currency: ${currency}.`);
  }
  return currency;
}
