import priceSources from "../../../spec/data/rates/price-sources.json" with { type: "json" };

export const HELLO_FRUIT_DIRECT_AMOUNT_CURRENCIES = ["BTC", "SATS"] as const;

export type HelloFruitDirectAmountCurrency = (typeof HELLO_FRUIT_DIRECT_AMOUNT_CURRENCIES)[number];

export type HelloFruitCurrency = string;

export function readHelloFruitPriceFeedCurrencies(): string[] {
  const primarySource = priceSources.sources.find((source) => source.id === "primary");
  if (primarySource === undefined || typeof primarySource.url !== "string") {
    throw new Error("Hello Fruit demo requires the primary price source.");
  }

  const currencies =
    new URL(primarySource.url).searchParams
      .get("vs_currencies")
      ?.split(",")
      .map((currency) => currency.trim().toUpperCase())
      .filter((currency) => /^[A-Z]{3}$/.test(currency)) ?? [];

  if (currencies.length === 0) {
    throw new Error("Hello Fruit demo requires at least one price-feed currency.");
  }

  return [...new Set(currencies)].sort();
}

/**
 * Currencies the Hello Fruit UI offers. Matches config/openreceive.ts (`USD`)
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
