import type { HelloFruitFiatAmount } from "./demo-formatting.ts";
import { formatHelloFruitFiat } from "./demo-formatting.ts";
import {
  DecimalError,
  convertAmountViaBtcRates,
  multiplyAmount,
  parseDecimal,
  sumAmounts,
  type BtcFiatRateMap,
} from "@openreceive/core";

export type HelloFruitBtcFiatRates = BtcFiatRateMap;

/** Rate keys are lowercase ISO 4217 codes, exactly as the demo servers emit them. */
const HELLO_FRUIT_RATE_CURRENCY_PATTERN = /^[a-z]{3}$/;

/**
 * THE parse boundary for a `GET /rates` body, shared by every demo client.
 *
 * Each demo keeps its own fetch — that is the integration style each one
 * exists to show — but none of them may keep its own idea of what a rate map
 * is. A cast (`body.rates as HelloFruitBtcFiatRates`) bounds the TYPE and
 * nothing else: the compiler then believes `rates.bitcoin.usd` is a decimal
 * string when the demo server may have sent no `bitcoin` object at all, or a
 * price the money engine cannot parse (Ruby's `BigDecimal#to_s` emits
 * `0.1e6`; a feed outage placeholder emits anything). Both reach a formatter
 * inside render.
 *
 * Returns `undefined` — the same "rates are not loaded" value every caller
 * already handles — when the body carries no usable rate, and drops individual
 * currencies it cannot use rather than failing the whole map, so one dead
 * currency never costs the ones that arrived intact.
 */
export function parseHelloFruitBtcFiatRates(payload: unknown): HelloFruitBtcFiatRates | undefined {
  const bitcoin = asHelloFruitRecord(asHelloFruitRecord(payload)?.bitcoin);
  if (bitcoin === undefined) return undefined;

  const rates: Record<string, string> = {};
  for (const [key, value] of Object.entries(bitcoin)) {
    const currency = key.toLowerCase();
    if (!HELLO_FRUIT_RATE_CURRENCY_PATTERN.test(currency)) continue;
    const rate = usableHelloFruitBtcFiatRate(value);
    if (rate !== undefined) rates[currency] = rate;
  }

  return Object.keys(rates).length === 0 ? undefined : { bitcoin: rates };
}

/**
 * A rate is usable when it is a positive decimal the shared money engine can
 * parse — the same question `parseBtcFiatPrice` asks before it throws, asked
 * here where the answer can be "skip this currency" instead.
 */
function usableHelloFruitBtcFiatRate(value: unknown): string | undefined {
  const rate = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof rate !== "string") return undefined;
  try {
    return parseDecimal(rate).units > 0n ? rate : undefined;
  } catch {
    return undefined;
  }
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
 * `DecimalError` for a bad amount, `PriceFeedError` for a
 * missing or malformed rate, `TypeError` for a rate map that is not shaped like
 * one — and a display boundary that enumerates error types is a boundary that
 * leaks the next one. {@link parseHelloFruitBtcFiatRates} is what keeps a
 * malformed server payload out of the state in the first place; this is the
 * second half of that pair, not a substitute for it.
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
