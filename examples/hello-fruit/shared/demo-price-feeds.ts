import {
  getBtcFiatRatesWithFallback,
  type OpenReceiveBtcFiatRateMap,
  type OpenReceiveSourcedPriceProvider,
} from "@openreceive/core";
import {
  helloFruitOrderRateCurrencies,
  normalizeHelloFruitCurrency,
  readHelloFruitCheckoutCurrencies,
  readHelloFruitPriceFeedCurrencies,
} from "./demo-currencies.ts";

export async function readHelloFruitOrderRates(input: {
  readonly currency: unknown;
  readonly priceProviders: readonly OpenReceiveSourcedPriceProvider[];
  readonly supportedCurrencies?: readonly string[];
}): Promise<OpenReceiveBtcFiatRateMap | undefined> {
  const supportedCurrencies =
    input.supportedCurrencies ?? readHelloFruitCheckoutCurrencies();
  const currency = normalizeHelloFruitCurrency(input.currency, [
    ...supportedCurrencies,
  ]);
  const currencies = helloFruitOrderRateCurrencies(currency);
  if (currencies.length === 0) return undefined;
  const rates = await getBtcFiatRatesWithFallback({
    currencies,
    providers: input.priceProviders,
  });
  return rates.rates;
}

/**
 * Loads BTC/fiat exchange rates for every checkout currency so a front end can
 * convert the USD catalog prices for display. This is demo-only presentation
 * glue; OpenReceive exposes the rate-fetching function, the demo wires the route.
 */
export async function readHelloFruitDisplayRates(input: {
  readonly priceProviders: readonly OpenReceiveSourcedPriceProvider[];
  readonly priceCurrencies?: readonly string[];
}): Promise<OpenReceiveBtcFiatRateMap> {
  const priceCurrencies =
    input.priceCurrencies ?? readHelloFruitPriceFeedCurrencies();
  const rates = await getBtcFiatRatesWithFallback({
    currencies: priceCurrencies,
    providers: input.priceProviders,
  });
  return rates.rates;
}
