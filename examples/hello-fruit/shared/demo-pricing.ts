import type { HelloFruitFiatAmount } from "./demo-formatting.ts";
import { formatHelloFruitFiat } from "./demo-formatting.ts";
import {
  DecimalError,
  convertAmountViaBtcRates,
  multiplyAmount,
  sumAmounts,
  type BtcFiatRateMap,
} from "@openreceive/core";

export type HelloFruitBtcFiatRates = BtcFiatRateMap;

/**
 * Shape adaptation for a `GET /rates` body, shared by every demo client.
 *
 * Each demo keeps its own fetch — that is the integration style each one
 * exists to show — but none of them may keep its own idea of what a rate map
 * is. The one real difference between the engines is the value type: the JS
 * service serializes rates as JSON numbers and the Ruby service as decimal
 * strings, so numbers are coerced to strings here. That is adapter work.
 *
 * It is NOT a validation boundary. `/rates` is the demo's own endpoint over
 * the trusted service's `listRates`, so a rate that arrives is a rate. Rates
 * arriving LATE is the real case every caller handles, and `undefined` — the
 * same "rates are not loaded" value — is the answer for a body with no
 * `bitcoin` map yet.
 */
export function parseHelloFruitBtcFiatRates(payload: unknown): HelloFruitBtcFiatRates | undefined {
  const bitcoin = asHelloFruitRecord(asHelloFruitRecord(payload)?.bitcoin);
  if (bitcoin === undefined) return undefined;

  const rates: Record<string, string> = {};
  for (const [key, value] of Object.entries(bitcoin)) {
    rates[key.toLowerCase()] = String(value);
  }

  return Object.keys(rates).length === 0 ? undefined : { bitcoin: rates };
}

function asHelloFruitRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Converts a USD catalog amount into the selected display currency.
 *
 * TOTAL: any amount it cannot convert falls back to the USD catalog amount —
 * rates not loaded yet, no rate for the selected currency, a rate the money
 * engine rejects. Every caller is a render path (the fruit grid, each cart
 * row, the buy-now label), so the cost of an unconvertible price is that ONE
 * price showing in USD, never the shop failing to render. Its throwing sibling
 * is {@link convertHelloFruitUsdAmount}, which the host uses for order math,
 * where a bad rate must surface instead of quietly pricing an order wrong.
 *
 * The catch is deliberately unfiltered. Conversion throws at least three ways —
 * `DecimalError` for a bad amount, `PriceFeedError` for a missing rate,
 * `TypeError` for a rate map that is not shaped like one — and a display
 * boundary that enumerates error types is a boundary that leaks the next one.
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
  } catch {
    return amount;
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
    throw new DecimalError("Hello Fruit catalog prices must use USD as the base currency.");
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
