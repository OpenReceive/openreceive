import {
  getBtcFiatRatesWithFallback,
  type OpenReceiveBtcFiatRateMap,
  type OpenReceiveSourcedPriceProvider
} from "@openreceive/core";
import {
  helloFruitOrderRateCurrencies,
  normalizeHelloFruitCurrency,
  readHelloFruitCheckoutCurrencies
} from "./demo-currencies.ts";

export async function readHelloFruitOrderRates(input: {
  readonly currency: unknown;
  readonly priceProviders: readonly OpenReceiveSourcedPriceProvider[];
  readonly supportedCurrencies?: readonly string[];
}): Promise<OpenReceiveBtcFiatRateMap | undefined> {
  const supportedCurrencies = input.supportedCurrencies ?? readHelloFruitCheckoutCurrencies();
  const currency = normalizeHelloFruitCurrency(input.currency, [...supportedCurrencies]);
  const currencies = helloFruitOrderRateCurrencies(currency);
  if (currencies.length === 0) return undefined;
  const rates = await getBtcFiatRatesWithFallback({
    currencies,
    providers: input.priceProviders
  });
  return rates.rates;
}
