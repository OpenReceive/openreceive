/**
 * Indicative quotes from a cached XML rate pair: pair → SwapQuote with min/max
 * checks on both the pay-in and invoice side, plus the mapping of any failure
 * (weight budget, transport, provider prose) to an availability reason and its
 * payer-facing message. `/create` stays the binding rate.
 */

import type { SwapPayInAsset } from "./assets.ts";
import {
  compareFixedFloatDecimalAmounts,
  type FixedFloatRatePair,
  invoiceLimitsFromFixedFloatRate,
  quotePayAmountFromFixedFloatRate,
} from "./fixedfloat-rates.ts";
import { FixedFloatApiError } from "./fixedfloat-transport.ts";
import type { SwapAvailabilityReason, SwapQuote } from "./provider.ts";
import { isSwapProviderWeightBudgetError } from "./weight-budget.ts";

export function fixedFloatQuoteFromRatePair(input: {
  /** The from→Lightning pair from the rates index, or undefined when it is not listed. */
  readonly pair: FixedFloatRatePair | undefined;
  readonly payInAsset: SwapPayInAsset;
  readonly invoiceAmountMsats: number;
  readonly provider: string;
}): SwapQuote {
  const { pair } = input;
  if (pair === undefined) {
    return {
      pay_asset: input.payInAsset,
      available: false,
      unavailable_reason: "pair_temporarily_unavailable",
      unavailable_message: fixedFloatAvailabilityMessage("pair_temporarily_unavailable"),
      provider: input.provider,
    };
  }
  const limits = invoiceLimitsFromFixedFloatRate(pair);
  const payAmount = quotePayAmountFromFixedFloatRate({
    pair,
    invoiceAmountMsats: input.invoiceAmountMsats,
  });
  if (payAmount === undefined) {
    return {
      pay_asset: input.payInAsset,
      available: false,
      unavailable_reason: "pair_temporarily_unavailable",
      unavailable_message: fixedFloatAvailabilityMessage("pair_temporarily_unavailable"),
      provider: input.provider,
      ...limits,
    };
  }
  // Prefer invoice-side limits when conversion succeeded; also compare the
  // indicative pay amount to XML min/max so padded `<out>` decimals (or any
  // future conversion miss) cannot leave a below-min asset selectable.
  const payBelowMin = compareFixedFloatDecimalAmounts(payAmount, limits.minimum_pay_amount) === -1;
  const payAboveMax = compareFixedFloatDecimalAmounts(payAmount, limits.maximum_pay_amount) === 1;
  const amountTooSmall =
    payBelowMin ||
    (limits.minimum_invoice_amount_msats !== undefined &&
      input.invoiceAmountMsats < limits.minimum_invoice_amount_msats);
  const amountTooLarge =
    payAboveMax ||
    (limits.maximum_invoice_amount_msats !== undefined &&
      input.invoiceAmountMsats > limits.maximum_invoice_amount_msats);
  if (amountTooSmall || amountTooLarge) {
    const reason = amountTooSmall ? "amount_too_small" : "amount_too_large";
    return {
      pay_asset: input.payInAsset,
      available: false,
      unavailable_reason: reason,
      unavailable_message: fixedFloatAvailabilityMessage(reason),
      provider: input.provider,
      ...limits,
    };
  }
  return {
    pay_amount: payAmount,
    pay_asset: input.payInAsset,
    available: true,
    provider: input.provider,
    ...limits,
  };
}

type QuoteErrorPattern = readonly [RegExp, SwapAvailabilityReason];

/**
 * Stringly-typed fallbacks for a quote failure that carries no machine-readable
 * code: FixedFloat reports "amount too small" in prose only. First match wins, so
 * the order is the priority order, and both callers below share one table so the
 * amount rules cannot drift apart again.
 */
const AMOUNT_QUOTE_ERROR_PATTERNS: readonly QuoteErrorPattern[] = [
  [/min|small|out of limits|limit_min/, "amount_too_small"],
  [/max|large|limit_max/, "amount_too_large"],
];

/** A non-API error exposes no status or kind, so transport is read from the message too. */
const ANY_QUOTE_ERROR_PATTERNS: readonly QuoteErrorPattern[] = [
  [/rate|429|weight budget/, "provider_rate_limited"],
  [/fetch|network|timeout/, "provider_unreachable"],
  ...AMOUNT_QUOTE_ERROR_PATTERNS,
];

function classifyQuoteErrorMessage(
  message: string,
  patterns: readonly QuoteErrorPattern[],
): SwapAvailabilityReason {
  for (const [pattern, reason] of patterns) {
    if (pattern.test(message)) return reason;
  }
  return "pair_temporarily_unavailable";
}

export function classifyFixedFloatQuoteError(error: unknown): SwapAvailabilityReason {
  if (isSwapProviderWeightBudgetError(error)) return "provider_rate_limited";
  if (error instanceof FixedFloatApiError) {
    if (error.kind === "rate_limited" || error.status === 429) return "provider_rate_limited";
    if (
      error.kind === "timeout" ||
      error.kind === "network" ||
      error.kind === "invalid_json" ||
      (error.status !== undefined && error.status >= 500)
    ) {
      return "provider_unreachable";
    }
    // The API answered, so transport is known good: only the amount rules apply.
    return classifyQuoteErrorMessage(
      error.fixedFloatMessage?.toLowerCase() ?? error.message.toLowerCase(),
      AMOUNT_QUOTE_ERROR_PATTERNS,
    );
  }
  return classifyQuoteErrorMessage(
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase(),
    ANY_QUOTE_ERROR_PATTERNS,
  );
}

export function fixedFloatAvailabilityMessage(reason: SwapAvailabilityReason): string {
  if (reason === "amount_too_small") return "This invoice is below the provider minimum.";
  if (reason === "amount_too_large") return "This invoice is above the provider maximum.";
  if (reason === "provider_rate_limited") return "The swap provider is rate limited.";
  if (reason === "provider_unreachable") return "The swap provider is temporarily unreachable.";
  return "This payment route is temporarily unavailable.";
}
