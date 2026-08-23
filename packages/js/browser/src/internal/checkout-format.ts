// Display formatting for the checkout UI: the countdown, amounts (msats,
// fiat, the combined caption), swap limits, the short labels for a payment
// hash / timestamp / invoice, and the HTML escaper every string renderer runs
// values through. Pure functions over values — nothing here reads a snapshot.

import { ceilDiv, formatDecimal, type Decimal, parseDecimal } from "@openreceive/core";

export function formatCountdown(seconds: number): string {
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
export function formatDepositAmount(amount: string): string {
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(amount) || !amount.includes(".")) return amount;
  return amount.replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Exported for ./checkout-swap-view.ts, which shares the same money engine.
 * Parses with the shared money engine but returns undefined instead of
 * throwing, so the caller can skip the row on a non-numeric string.
 */
export function optionalDecimal(value: string): Decimal | undefined {
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

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * THE msat rule, in one place: is this a value `formatMsats` can be
 * handed?
 *
 * Every rule in this file that judges an msat amount asks this instead of
 * repeating the `Number.isSafeInteger(...) && ... >= 0` pair, so the rule has
 * exactly one definition. `undefined` answers false, so callers holding an
 * optional amount need no extra check.
 */
function isDisplayableMsats(amountMsats: number | undefined): amountMsats is number {
  return amountMsats !== undefined && Number.isSafeInteger(amountMsats) && amountMsats >= 0;
}

/**
 * Throws on a non-amount, and every caller lets it: wire construction, amount
 * validation, and the display sites share this formatter, and a malformed
 * amount from our own server is a bug that must surface, not be smoothed over.
 */
export function formatMsats(amountMsats: number): string {
  if (!isDisplayableMsats(amountMsats)) {
    throw new RangeError("amount_msats must be a non-negative safe integer");
  }

  if (amountMsats % 1000 === 0) {
    const sats = amountMsats / 1000;
    return `${formatInteger(sats)} ${sats === 1 ? "sat" : "sats"}`;
  }

  return `${formatInteger(amountMsats)} msats`;
}

export function formatFiatAmount(
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
export function formatAmountCaption(options: {
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

function formatInteger(value: number): string {
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
export function formatSwapLimit(
  checkout: {
    readonly amount_msats: number;
    readonly fiat?: { readonly currency: string; readonly value: string };
  },
  limitMsats: number | undefined,
  rounding: "ceil" | "floor" = "ceil",
): string | undefined {
  // Same displayability rule as every other amount; the extra `=== 0` is this
  // function's own: the checkout amount is a DENOMINATOR below.
  if (
    !isDisplayableMsats(limitMsats) ||
    !isDisplayableMsats(checkout.amount_msats) ||
    checkout.amount_msats === 0
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
      const formatted = formatFiatAmount({
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

export function formatPaymentHashLabel(hash: string): string {
  return hash.length <= 16 ? hash : `${hash.slice(0, 8)}...${hash.slice(-8)}`;
}

/**
 * The largest unix-seconds value a `Date` can represent. The ECMAScript time
 * range is +/- 8.64e15 ms (ES2024 21.4.1.1); past it every `Date` method that
 * renders — `toISOString`, `toLocaleString` — throws `RangeError: Invalid time
 * value`.
 */
const MAX_DISPLAYABLE_UNIX_SECONDS = 8.64e15 / 1000;

/**
 * THE unix-timestamp rule, in one place: is this a value a clock can render?
 * Sibling of {@link isDisplayableMsats}. Renderability only — the ceiling is
 * the `Date` range and nothing narrower.
 */
function isDisplayableUnixSeconds(seconds: number | undefined): seconds is number {
  return (
    seconds !== undefined &&
    Number.isFinite(seconds) &&
    seconds > 0 &&
    seconds <= MAX_DISPLAYABLE_UNIX_SECONDS
  );
}

/**
 * ECHOES rather than throws on a value it cannot render — the one place this
 * rule reads differently from the amount rule above, deliberately.
 * `formatMsats` throws because wire construction and amount validation share
 * it and a bad amount there must surface; nothing constructs or validates
 * anything through this formatter, so degrading to the raw value is its
 * contract.
 */
export function formatUnixTime(seconds: number): string {
  if (!isDisplayableUnixSeconds(seconds)) return String(seconds);
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function formatInvoiceLabel(invoice: string): string {
  if (invoice.length <= 48) return invoice;
  return `${invoice.slice(0, 20)}…${invoice.slice(-16)}`;
}

/** The payer-facing labels a {@link CheckoutState} carries next to its raw fields. */
export interface CheckoutStateLabels {
  readonly amountLabel?: string;
  readonly fiatLabel?: string;
  readonly paymentHashLabel?: string;
}

/**
 * THE label rule — one copy, applied everywhere a checkout is shown.
 *
 * `normalizeCheckoutState` runs it so every CheckoutState already carries its
 * labels, and the elements renderer runs it over raw attributes in create mode,
 * before there is an attempt to build a state from. It replaces the label half
 * of the deleted `createCheckoutDisplayModel`; the other half (the `lightning:`
 * URI) belongs to `createCheckoutState`, which is the only place that knows the
 * rail.
 *
 * `transactionStateLabel` is deliberately NOT here: it was a verbatim copy of
 * `transaction_state`, which the state already carries, and nothing read it.
 */
export function deriveCheckoutStateLabels(source: {
  readonly amount_msats?: number;
  readonly fiat_quote?: {
    readonly fiat?: {
      readonly currency?: string;
      readonly value?: string;
    };
  } | null;
  readonly payment_hash?: string;
}): CheckoutStateLabels {
  const fiatLabel = formatFiatAmount(source.fiat_quote?.fiat);
  const amountLabel =
    source.amount_msats === undefined ? undefined : formatMsats(source.amount_msats);
  return {
    ...(amountLabel === undefined ? {} : { amountLabel }),
    ...(fiatLabel === undefined ? {} : { fiatLabel }),
    ...(source.payment_hash === undefined
      ? {}
      : { paymentHashLabel: formatPaymentHashLabel(source.payment_hash) }),
  };
}
