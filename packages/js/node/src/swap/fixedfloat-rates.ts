/**
 * FixedFloat public XML rates export — the bulk feed for all pairs.
 *
 * Docs: GET https://ff.io/rates/fixed.xml (and float.xml). No API key, no
 * weight budget. OpenReceive caches the parsed index in openreceive_meta and
 * derives indicative quotes / min-max locally. `/create` remains authoritative.
 */

import type { SwapRateType } from "./rates-cache.ts";

export interface FixedFloatRatePair {
  readonly from: string;
  readonly to: string;
  /** Reference send amount in `from` (defines the rate with `out`). */
  readonly in: string;
  /** Reference receive amount in `to`. */
  readonly out: string;
  /** Reserve availability hint for `to` — not a max exchange amount. */
  readonly amount: string;
  readonly minamount: string;
  readonly maxamount: string;
  /** Network fee on the `to` side, excluded from `out` (e.g. "0.0005 BTC"). */
  readonly tofee?: string;
}

export interface FixedFloatRatesIndex {
  readonly fetched_at: number;
  /** Keyed as `${from.toUpperCase()}:${to.toUpperCase()}`. */
  readonly pairs: Readonly<Record<string, FixedFloatRatePair>>;
}

const DECIMAL_PATTERN = /^[0-9]+(\.[0-9]+)?$/;
const SATS_PER_BTC = 100_000_000n;

export function fixedFloatRatesPairKey(from: string, to: string): string {
  return `${from.trim().toUpperCase()}:${to.trim().toUpperCase()}`;
}

export function fixedFloatRatesXmlPath(rateType: SwapRateType = "fixed"): string {
  return `/rates/${rateType}.xml`;
}

export async function fetchFixedFloatRatesIndex(input: {
  readonly baseUrl: string;
  readonly rateType?: SwapRateType;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => number;
  readonly requestTimeoutMs?: number;
}): Promise<FixedFloatRatesIndex> {
  const rateType = input.rateType ?? "fixed";
  const url = `${input.baseUrl.replace(/\/+$/, "")}${fixedFloatRatesXmlPath(rateType)}`;
  const timeoutMs = input.requestTimeoutMs ?? 10_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await input.fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { Accept: "application/xml, text/xml, */*" },
    });
  } catch (error) {
    const aborted =
      error instanceof Error &&
      (error.name === "AbortError" || error.message.toLowerCase().includes("abort"));
    throw new Error(
      aborted
        ? `FixedFloat rates ${rateType}.xml request timed out.`
        : `FixedFloat rates ${rateType}.xml request failed before a response was received.`,
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(`FixedFloat rates ${rateType}.xml failed with HTTP ${response.status}.`);
  }
  const xml = await response.text();
  return {
    fetched_at: input.now(),
    pairs: parseFixedFloatRatesXml(xml),
  };
}

export function parseFixedFloatRatesXml(xml: string): Readonly<Record<string, FixedFloatRatePair>> {
  const pairs: Record<string, FixedFloatRatePair> = {};
  for (const itemXml of matchTags(xml, "item")) {
    const from = readTagText(itemXml, "from");
    const to = readTagText(itemXml, "to");
    const inAmount = readTagText(itemXml, "in");
    const outAmount = readTagText(itemXml, "out");
    const amount = readTagText(itemXml, "amount");
    const minamount = readTagText(itemXml, "minamount");
    const maxamount = readTagText(itemXml, "maxamount");
    if (
      from === undefined ||
      to === undefined ||
      inAmount === undefined ||
      outAmount === undefined ||
      amount === undefined ||
      minamount === undefined ||
      maxamount === undefined
    ) {
      continue;
    }
    const tofee = readTagText(itemXml, "tofee");
    const pair: FixedFloatRatePair = {
      from: from.trim(),
      to: to.trim(),
      in: stripCurrencySuffix(inAmount),
      out: stripCurrencySuffix(outAmount),
      amount: stripCurrencySuffix(amount),
      minamount: stripCurrencySuffix(minamount),
      maxamount: stripCurrencySuffix(maxamount),
      ...(tofee === undefined ? {} : { tofee: tofee.trim() }),
    };
    pairs[fixedFloatRatesPairKey(pair.from, pair.to)] = pair;
  }
  return pairs;
}

export function serializeFixedFloatRatesIndex(index: FixedFloatRatesIndex): string {
  return JSON.stringify({
    fetched_at: index.fetched_at,
    pairs: index.pairs,
  });
}

export function deserializeFixedFloatRatesIndex(value: string): FixedFloatRatesIndex {
  const parsed = JSON.parse(value) as {
    readonly fetched_at?: unknown;
    readonly pairs?: unknown;
  };
  if (
    typeof parsed.fetched_at !== "number" ||
    !Number.isSafeInteger(parsed.fetched_at) ||
    parsed.pairs === null ||
    typeof parsed.pairs !== "object" ||
    Array.isArray(parsed.pairs)
  ) {
    throw new Error("Invalid FixedFloat rates cache blob.");
  }
  const pairs: Record<string, FixedFloatRatePair> = {};
  for (const [key, raw] of Object.entries(parsed.pairs as Record<string, unknown>)) {
    const pair = readStoredPair(raw);
    if (pair !== undefined) pairs[key] = pair;
  }
  return { fetched_at: parsed.fetched_at, pairs };
}

/**
 * Indicative pay-in amount for a Lightning payout of `invoiceAmountMsats`,
 * using the XML reference rate (`in`/`out`) and optional BTC `tofee`.
 *
 * Formula (direction=to): pay_from = (invoice_btc + tofee_btc) × (in / out).
 * Rounds the pay-in amount up at 8 decimal places so the UI never understates
 * what `/create` is likely to require.
 */
export function quotePayAmountFromFixedFloatRate(input: {
  readonly pair: FixedFloatRatePair;
  readonly invoiceAmountMsats: number;
}): string | undefined {
  if (!Number.isSafeInteger(input.invoiceAmountMsats) || input.invoiceAmountMsats <= 0) {
    return undefined;
  }
  const rateIn = parsePositiveDecimal(input.pair.in);
  const rateOut = parsePositiveDecimal(input.pair.out);
  if (rateIn === undefined || rateOut === undefined) return undefined;

  const invoiceSats = BigInt(Math.ceil(input.invoiceAmountMsats / 1000));
  const tofeeSats = parseToFeeBtcSats(input.pair.tofee) ?? 0n;
  const totalSats = invoiceSats + tofeeSats;
  if (rateOut.integer <= 0n) return undefined;

  // pay_from = total_btc * (in/out) = total_sats * in / (out * 1e8).
  // Compute ceil(total_sats * in / out) as an 8-decimal fixed-point integer of
  // the from currency (i.e. units of 1e-8), then format — never binary floats.
  const payAt8Dp = ceilDiv(
    totalSats * rateIn.integer * rateOut.scale,
    rateIn.scale * rateOut.integer,
  );
  return formatDecimal(payAt8Dp, SATS_PER_BTC, 8);
}

/**
 * Maps XML from-side min/max into invoice-side msats using the pair's reference rate.
 * Minimum rounds up, maximum rounds down, so borderline invoices are never reported
 * as inside a range the provider would reject.
 */
export function invoiceLimitsFromFixedFloatRate(pair: FixedFloatRatePair): {
  readonly minimum_pay_amount: string;
  readonly maximum_pay_amount: string;
  readonly minimum_invoice_amount_msats?: number;
  readonly maximum_invoice_amount_msats?: number;
} {
  const minimumPayAmount = pair.minamount;
  const maximumPayAmount = pair.maxamount;
  const payUnitsPerSat = payUnitsPerInvoiceSat(pair);
  return {
    minimum_pay_amount: minimumPayAmount,
    maximum_pay_amount: maximumPayAmount,
    ...(payUnitsPerSat === undefined
      ? {}
      : {
          ...(payAmountToInvoiceMsats(minimumPayAmount, payUnitsPerSat, "ceil") === undefined
            ? {}
            : {
                minimum_invoice_amount_msats: payAmountToInvoiceMsats(
                  minimumPayAmount,
                  payUnitsPerSat,
                  "ceil",
                ),
              }),
          ...(payAmountToInvoiceMsats(maximumPayAmount, payUnitsPerSat, "floor") === undefined
            ? {}
            : {
                maximum_invoice_amount_msats: payAmountToInvoiceMsats(
                  maximumPayAmount,
                  payUnitsPerSat,
                  "floor",
                ),
              }),
        }),
  };
}

function payUnitsPerInvoiceSat(pair: FixedFloatRatePair): number | undefined {
  const rateIn = Number(pair.in);
  const outSats = btcAmountStringToSats(pair.out);
  if (!Number.isFinite(rateIn) || rateIn <= 0) return undefined;
  if (outSats === undefined || outSats <= 0) return undefined;
  return rateIn / outSats;
}

function payAmountToInvoiceMsats(
  payAmount: string,
  payUnitsPerSat: number,
  rounding: "ceil" | "floor",
): number | undefined {
  const value = Number(payAmount);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const invoiceSats = value / payUnitsPerSat;
  if (!Number.isFinite(invoiceSats) || invoiceSats <= 0) return undefined;
  const roundedSats = rounding === "ceil" ? Math.ceil(invoiceSats) : Math.floor(invoiceSats);
  const msats = roundedSats * 1000;
  return Number.isSafeInteger(msats) ? msats : undefined;
}

function btcAmountStringToSats(value: string): number | undefined {
  if (!DECIMAL_PATTERN.test(value)) return undefined;
  const [wholePart, fractionalPart = ""] = value.split(".");
  if (fractionalPart.length > 8) return undefined;
  const sats = BigInt(wholePart) * SATS_PER_BTC + BigInt(fractionalPart.padEnd(8, "0"));
  return sats <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(sats) : undefined;
}

function parseToFeeBtcSats(tofee: string | undefined): bigint | undefined {
  if (tofee === undefined) return undefined;
  // Examples: "0.0004967000 BTC", "0.0005 BTCLN". Non-BTC fees are ignored —
  // we always pay out Lightning BTC, so only BTC network fees fold into pay-in.
  const match = tofee.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z]+)?$/);
  if (match === null) return undefined;
  const amount = match[1];
  const unit = (match[2] ?? "BTC").toUpperCase();
  if (unit !== "BTC" && unit !== "BTCLN") return undefined;
  const parsed = parsePositiveDecimal(amount);
  if (parsed === undefined) return undefined;
  if (parsed.scale > SATS_PER_BTC) return undefined;
  return (parsed.integer * SATS_PER_BTC) / parsed.scale;
}

function parsePositiveDecimal(
  value: string,
): { integer: bigint; scale: bigint } | undefined {
  if (!DECIMAL_PATTERN.test(value)) return undefined;
  const [whole, fraction = ""] = value.split(".");
  const integer = BigInt(`${whole}${fraction}`);
  if (integer <= 0n) return undefined;
  return { integer, scale: 10n ** BigInt(fraction.length) };
}

function formatDecimal(integer: bigint, scale: bigint, maxFractionDigits: number): string {
  const whole = integer / scale;
  let fraction = integer % scale;
  // Truncate/pad to maxFractionDigits, then round up any discarded remainder.
  const targetScale = 10n ** BigInt(maxFractionDigits);
  if (scale > targetScale) {
    const divisor = scale / targetScale;
    const remainder = fraction % divisor;
    fraction = fraction / divisor;
    if (remainder > 0n) fraction += 1n;
    if (fraction >= targetScale) {
      return formatDecimal(whole * targetScale + fraction, targetScale, maxFractionDigits);
    }
    scale = targetScale;
  } else if (scale < targetScale) {
    fraction *= targetScale / scale;
    scale = targetScale;
  }
  const fractionText = fraction.toString().padStart(maxFractionDigits, "0").replace(/0+$/, "");
  return fractionText.length === 0 ? whole.toString() : `${whole.toString()}.${fractionText}`;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function stripCurrencySuffix(value: string): string {
  const match = value.trim().match(/^([0-9]+(?:\.[0-9]+)?)/);
  return match?.[1] ?? value.trim();
}

function matchTags(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  const matches: string[] = [];
  for (const match of xml.matchAll(pattern)) {
    matches.push(match[1] ?? "");
  }
  return matches;
}

function readTagText(xml: string, tag: string): string | undefined {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const match = xml.match(pattern);
  if (match === null) return undefined;
  const text = (match[1] ?? "").trim();
  return text.length === 0 ? undefined : text;
}

function readStoredPair(value: unknown): FixedFloatRatePair | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const from = typeof record.from === "string" ? record.from : undefined;
  const to = typeof record.to === "string" ? record.to : undefined;
  const inAmount = typeof record.in === "string" ? record.in : undefined;
  const outAmount = typeof record.out === "string" ? record.out : undefined;
  const amount = typeof record.amount === "string" ? record.amount : undefined;
  const minamount = typeof record.minamount === "string" ? record.minamount : undefined;
  const maxamount = typeof record.maxamount === "string" ? record.maxamount : undefined;
  if (
    from === undefined ||
    to === undefined ||
    inAmount === undefined ||
    outAmount === undefined ||
    amount === undefined ||
    minamount === undefined ||
    maxamount === undefined
  ) {
    return undefined;
  }
  return {
    from,
    to,
    in: inAmount,
    out: outAmount,
    amount,
    minamount,
    maxamount,
    ...(typeof record.tofee === "string" ? { tofee: record.tofee } : {}),
  };
}
