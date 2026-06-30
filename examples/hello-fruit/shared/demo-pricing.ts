import type { HelloFruitFiatAmount } from "./demo-formatting.ts";
import { formatHelloFruitFiat } from "./demo-formatting.ts";

export interface HelloFruitBtcFiatRates {
  readonly bitcoin: Readonly<Record<string, string>>;
}

export class HelloFruitPricingError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "HelloFruitPricingError";
    this.status = status;
  }
}

/**
 * Converts a USD catalog amount into the selected display currency, falling
 * back to the base amount when rates are not loaded yet or a rate is missing.
 * Demo-only presentation glue: keeps the displayed price aligned with the
 * server-side order math without throwing while a front end is still loading.
 */
export function toHelloFruitDisplayAmount(
  amount: HelloFruitFiatAmount,
  currency: string,
  rates: HelloFruitBtcFiatRates | undefined,
): HelloFruitFiatAmount {
  if (currency === amount.currency) return amount;
  if (rates === undefined) return amount;
  try {
    return convertHelloFruitUsdAmount(amount, currency, rates);
  } catch (error) {
    if (error instanceof HelloFruitPricingError) return amount;
    throw error;
  }
}

export function formatHelloFruitDisplayPrice(
  amount: HelloFruitFiatAmount,
  currency: string,
  rates: HelloFruitBtcFiatRates | undefined,
): string {
  return formatHelloFruitFiat(
    toHelloFruitDisplayAmount(amount, currency, rates),
  );
}

export function convertHelloFruitUsdAmount(
  amount: HelloFruitFiatAmount,
  currency: string,
  rates: HelloFruitBtcFiatRates | undefined,
): HelloFruitFiatAmount {
  if (amount.currency !== "USD") {
    throw new HelloFruitPricingError(
      "Hello Fruit catalog prices must use USD as the base currency.",
    );
  }
  if (currency === "USD") return amount;

  const usdRate = requiredHelloFruitRate(rates, "USD");
  if (currency === "BTC" || currency === "SATS") {
    const sats = usdToSats(amount.value, usdRate);
    return {
      currency,
      value: currency === "BTC" ? formatBtcFromSats(sats) : sats.toString(),
    };
  }

  const targetRate = requiredHelloFruitRate(rates, currency);
  return {
    currency,
    value: convertUsdToFiat(amount.value, usdRate, targetRate),
  };
}

export function multiplyHelloFruitAmount(
  fiat: HelloFruitFiatAmount,
  quantity: number,
): HelloFruitFiatAmount {
  const decimal = parseDecimal(fiat.value);
  return {
    currency: fiat.currency,
    value: formatDecimal(decimal.units * BigInt(quantity), decimal.scale),
  };
}

export function sumHelloFruitAmounts(
  amounts: readonly HelloFruitFiatAmount[],
): HelloFruitFiatAmount {
  const first = amounts[0];
  if (first === undefined) {
    throw new HelloFruitPricingError(
      "At least one amount is required to total.",
    );
  }
  const currency = first.currency;
  let scale = 0;
  let totalUnits = 0n;

  for (const amount of amounts) {
    if (amount.currency !== currency) {
      throw new HelloFruitPricingError("Amounts must use one currency.");
    }
    const decimal = parseDecimal(amount.value);
    if (decimal.scale > scale) {
      totalUnits *= 10n ** BigInt(decimal.scale - scale);
      scale = decimal.scale;
    }
    totalUnits += decimal.units * 10n ** BigInt(scale - decimal.scale);
  }

  return {
    currency,
    value: formatDecimal(totalUnits, scale),
  };
}

export function requiredHelloFruitRate(
  rates: HelloFruitBtcFiatRates | undefined,
  currency: string,
): string {
  const rate = rates?.bitcoin[currency.toLowerCase()];
  if (rate === undefined) {
    throw new HelloFruitPricingError(
      `Missing BTC/${currency} price feed rate.`,
      503,
    );
  }
  return rate;
}

export function parseDecimal(value: string): {
  readonly units: bigint;
  readonly scale: number;
} {
  if (!/^\d+(?:\.\d+)?$/.test(value)) {
    throw new HelloFruitPricingError(
      "Fiat prices must be positive decimal strings.",
    );
  }
  const [integer, fraction = ""] = value.split(".");
  return {
    units: BigInt(`${integer}${fraction}`),
    scale: fraction.length,
  };
}

export function usdToSats(usdValue: string, usdBtcPrice: string): bigint {
  const usd = parseDecimal(usdValue);
  const price = parseDecimal(usdBtcPrice);
  if (price.units <= 0n) {
    throw new HelloFruitPricingError(
      "BTC/USD price feed rate must be greater than zero.",
      503,
    );
  }
  const numerator = usd.units * BigInt(price.scale) * 100_000_000n;
  const denominator = price.units * BigInt(usd.scale);
  return ceilDiv(numerator, denominator);
}

export function convertUsdToFiat(
  usdValue: string,
  usdBtcPrice: string,
  targetBtcPrice: string,
): string {
  const usd = parseDecimal(usdValue);
  const usdPrice = parseDecimal(usdBtcPrice);
  const targetPrice = parseDecimal(targetBtcPrice);
  if (usdPrice.units <= 0n || targetPrice.units <= 0n) {
    throw new HelloFruitPricingError(
      "BTC fiat price feed rates must be greater than zero.",
      503,
    );
  }

  const scale = 2;
  const outputScale = 10n ** BigInt(scale);
  const numerator =
    usd.units * targetPrice.units * BigInt(usdPrice.scale) * outputScale;
  const denominator =
    BigInt(usd.scale) * BigInt(targetPrice.scale) * usdPrice.units;
  return formatDecimal(ceilDiv(numerator, denominator), scale);
}

export function formatBtcFromSats(sats: bigint): string {
  return formatDecimal(sats, 8).replace(/0+$/, "").replace(/\.$/, "");
}

export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

export function formatDecimal(units: bigint, scale: number): string {
  if (scale === 0) return units.toString();
  const raw = units.toString().padStart(scale + 1, "0");
  const integer = raw.slice(0, -scale);
  const fraction = raw.slice(-scale);
  return `${integer}.${fraction}`;
}
