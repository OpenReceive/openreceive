/**
 * Indicative quotes from a cached XML rate pair: pair → SwapQuote with min/max
 * checks on both the pay-in and invoice side, plus the payer-facing message for
 * each availability reason. Nothing here throws — an unquotable pair is an
 * unavailable quote — so the caller needs no failure classifier. `/create`
 * stays the binding rate.
 */

import type { SwapPayInAsset } from "./assets.ts";
import {
  compareFixedFloatDecimalAmounts,
  type FixedFloatRatePair,
  invoiceLimitsFromFixedFloatRate,
  quotePayAmountFromFixedFloatRate,
} from "./fixedfloat-rates.ts";
import type { SwapAvailabilityReason, SwapQuote } from "./provider.ts";

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

export function fixedFloatAvailabilityMessage(reason: SwapAvailabilityReason): string {
  if (reason === "amount_too_small") return "This invoice is below the provider minimum.";
  if (reason === "amount_too_large") return "This invoice is above the provider maximum.";
  if (reason === "provider_rate_limited") return "The swap provider is rate limited.";
  if (reason === "provider_unreachable") return "The swap provider is temporarily unreachable.";
  return "This payment route is temporarily unavailable.";
}
