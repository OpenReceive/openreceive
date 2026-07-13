import type { HelloFruitFiatAmount } from "./demo-formatting.ts";
import { formatHelloFruitFiat } from "./demo-formatting.ts";
import {
  OpenReceiveDecimalError,
  convertAmountViaBtcRates,
  multiplyAmount,
  requiredBtcFiatRate,
  sumAmounts,
  type OpenReceiveBtcPriceRates,
} from "@openreceive/core";

export type HelloFruitBtcFiatRates = OpenReceiveBtcPriceRates;

/** @deprecated Prefer {@link OpenReceiveDecimalError} from `@openreceive/core`. */
export class HelloFruitPricingError extends OpenReceiveDecimalError {
  constructor(message: string, status = 400) {
    super(message, status);
    this.name = "HelloFruitPricingError";
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
    if (error instanceof OpenReceiveDecimalError) return amount;
    throw error;
  }
}

export function formatHelloFruitDisplayPrice(
  amount: HelloFruitFiatAmount,
  currency: string,
  rates: HelloFruitBtcFiatRates | undefined,
): string {
  return formatHelloFruitFiat(toHelloFruitDisplayAmount(amount, currency, rates));
}

export function convertHelloFruitUsdAmount(
  amount: HelloFruitFiatAmount,
  currency: string,
  rates: HelloFruitBtcFiatRates | undefined,
): HelloFruitFiatAmount {
  if (amount.currency !== "USD") {
    throw new OpenReceiveDecimalError(
      "Hello Fruit catalog prices must use USD as the base currency.",
    );
  }
  return convertAmountViaBtcRates(amount, currency, rates);
}

export function multiplyHelloFruitAmount(
  fiat: HelloFruitFiatAmount,
  quantity: number,
): HelloFruitFiatAmount {
  return multiplyAmount(fiat, quantity);
}

export function sumHelloFruitAmounts(
  amounts: readonly HelloFruitFiatAmount[],
): HelloFruitFiatAmount {
  return sumAmounts(amounts);
}

export function requiredHelloFruitRate(
  rates: HelloFruitBtcFiatRates | undefined,
  currency: string,
): string {
  return requiredBtcFiatRate(rates, currency);
}

export {
  ceilDiv,
  convertFiatViaBtcPrices as convertUsdToFiat,
  fiatValueToSats as usdToSats,
  formatBtcFromSats,
  formatDecimal,
  parseDecimal,
  satsToFiatValue,
} from "@openreceive/core";
