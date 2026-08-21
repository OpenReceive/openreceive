// Display formatting for the checkout UI: the countdown, amounts (msats,
// fiat, the combined caption), swap limits, the short labels for a payment
// hash / timestamp / invoice, and the HTML escaper every string renderer runs
// values through. Pure functions over values — nothing here reads a snapshot.

import { ceilDiv, formatDecimal, type OpenReceiveDecimal, parseDecimal } from "@openreceive/core";

export function formatOpenReceiveCountdown(seconds: number): string {
  const safeSeconds = Math.max(0, Math.trunc(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainderSeconds = safeSeconds % 60;
  return `${minutes}:${remainderSeconds.toString().padStart(2, "0")}`;
}

/**
 * Trim insignificant trailing zeros from a decimal crypto amount for display,
 * e.g. "12.25900000" -> "12.259" and "5.000" -> "5". Only fractional digits are
 * stripped: integer amounts like "100" keep their zeros, and non-numeric input
 * is returned unchanged.
 */
export function formatOpenReceiveDepositAmount(amount: string): string {
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(amount) || !amount.includes(".")) return amount;
  return amount.replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Exported for ./checkout-swap-view.ts, which shares the same money engine.
 *
 * Provider-supplied display decimals are untrusted strings: parse with the shared
 * money engine but return undefined instead of throwing so the caller can hide the
 * row rather than break the panel.
 */
export function optionalDecimal(value: string): OpenReceiveDecimal | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return parseDecimal(value);
  } catch {
    return undefined;
  }
}

/** Integer division rounded half up. */
export function roundedDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

/** Re-scale integer units from `scale` to `digits` decimal places, half-up. */
export function rescaleHalfUp(units: bigint, scale: number, digits: number): bigint {
  return roundedDiv(units * 10n ** BigInt(digits), 10n ** BigInt(scale));
}

export function escapeOpenReceiveHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function formatOpenReceiveMsats(amountMsats: number): string {
  if (!Number.isSafeInteger(amountMsats) || amountMsats < 0) {
    throw new RangeError("amount_msats must be a non-negative safe integer");
  }

  if (amountMsats % 1000 === 0) {
    const sats = amountMsats / 1000;
    return `${formatOpenReceiveInteger(sats)} ${sats === 1 ? "sat" : "sats"}`;
  }

  return `${formatOpenReceiveInteger(amountMsats)} msats`;
}

export function formatOpenReceiveFiatAmount(
  fiat:
    | {
        readonly currency?: string;
        readonly value?: string;
      }
    | null
    | undefined,
): string | undefined {
  if (fiat?.currency === undefined || fiat.value === undefined) return undefined;
  if (fiat.currency === "BTC") return `${fiat.value} BTC`;
  if (fiat.currency === "SATS") return `${fiat.value} sats`;
  return fiat.currency === "USD" ? `$${fiat.value}` : `${fiat.value} ${fiat.currency}`;
}

/** Combined QR caption, e.g. `19,174 sats / $12.00 US`. */
export function formatOpenReceiveAmountCaption(options: {
  readonly amountLabel?: string;
  readonly fiatLabel?: string;
  readonly fiatCurrency?: string;
}): string | undefined {
  const fiat =
    options.fiatLabel === undefined
      ? undefined
      : options.fiatCurrency === "USD" && !options.fiatLabel.endsWith(" US")
        ? `${options.fiatLabel} US`
        : options.fiatLabel;
  if (options.amountLabel !== undefined && fiat !== undefined) {
    return `${options.amountLabel} / ${fiat}`;
  }
  return options.amountLabel ?? fiat;
}

function formatOpenReceiveInteger(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * Renders an invoice-side (Lightning receive) msat limit as a short amount for
 * display under a disabled swap asset, e.g. "$10.00". Converts to the
 * checkout's own fiat currency using its rate; falls back to a sats figure when
 * the checkout is sats/BTC-denominated or no usable rate is available.
 *
 * Minimums ceil and maximums floor to the display scale so the note never
 * understates a floor or overstates a ceiling.
 */
export function formatOpenReceiveSwapLimit(
  checkout: {
    readonly amount_msats: number;
    readonly fiat?: { readonly currency: string; readonly value: string };
  },
  limitMsats: number | undefined,
  rounding: "ceil" | "floor" = "ceil",
): string | undefined {
  if (
    limitMsats === undefined ||
    !Number.isSafeInteger(limitMsats) ||
    limitMsats < 0 ||
    !Number.isSafeInteger(checkout.amount_msats) ||
    checkout.amount_msats <= 0
  ) {
    return undefined;
  }
  const fiat = checkout.fiat;
  if (fiat !== undefined && fiat.currency !== "SATS" && fiat.currency !== "BTC") {
    const scaled = scaleFiatLimitExact({
      fiatValue: fiat.value,
      amountMsats: checkout.amount_msats,
      limitMsats,
      rounding,
    });
    if (scaled !== undefined) {
      const formatted = formatOpenReceiveFiatAmount({
        currency: fiat.currency,
        value: scaled,
      });
      if (formatted !== undefined) return formatted;
    }
  }
  const sats = rounding === "floor" ? Math.floor(limitMsats / 1000) : Math.ceil(limitMsats / 1000);
  return `${sats} ${sats === 1 ? "sat" : "sats"}`;
}

/**
 * Exact `invoice_fiat * limit_msats / amount_msats` at two decimal places.
 * Uses bigint only — never binary floats.
 */
function scaleFiatLimitExact(input: {
  readonly fiatValue: string;
  readonly amountMsats: number;
  readonly limitMsats: number;
  readonly rounding: "ceil" | "floor";
}): string | undefined {
  const fiat = optionalDecimal(input.fiatValue);
  if (fiat === undefined || fiat.units <= 0n) return undefined;
  const outScale = 2;
  // result_units_at_2dp = round(fiat_units * limit / amount * 10^(2 - fiatScale))
  const numerator = fiat.units * BigInt(input.limitMsats) * 10n ** BigInt(outScale);
  const denominator = BigInt(input.amountMsats) * 10n ** BigInt(fiat.scale);
  if (denominator <= 0n) return undefined;
  const units =
    input.rounding === "floor" ? numerator / denominator : ceilDiv(numerator, denominator);
  return formatDecimal(units, outScale);
}

export function formatOpenReceivePaymentHashLabel(hash: string): string {
  return hash.length <= 16 ? hash : `${hash.slice(0, 8)}...${hash.slice(-8)}`;
}

export function formatOpenReceiveUnixTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return String(seconds);
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function formatOpenReceiveInvoiceLabel(invoice: string): string {
  if (invoice.length <= 48) return invoice;
  return `${invoice.slice(0, 20)}…${invoice.slice(-16)}`;
}
