import type { OpenReceiveBtcFiatRateMap } from "@openreceive/core";
import {
  helloFruitOrderRateCurrencies,
  normalizeHelloFruitCurrency,
  readHelloFruitCheckoutCurrencies,
} from "./demo-currencies.ts";

export async function readHelloFruitOrderRates(input: {
  readonly currency: unknown;
  readonly listRates: (currencies: readonly string[]) => Promise<OpenReceiveBtcFiatRateMap>;
  readonly supportedCurrencies?: readonly string[];
}): Promise<OpenReceiveBtcFiatRateMap | undefined> {
  const supportedCurrencies =
    input.supportedCurrencies ?? readHelloFruitCheckoutCurrencies();
  const currency = normalizeHelloFruitCurrency(input.currency, [
    ...supportedCurrencies,
  ]);
  const currencies = helloFruitOrderRateCurrencies(currency);
  if (currencies.length === 0) return undefined;
  return await input.listRates(currencies);
}
