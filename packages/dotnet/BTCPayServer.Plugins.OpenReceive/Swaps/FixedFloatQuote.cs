#nullable enable

namespace BTCPayServer.Plugins.OpenReceive.Swaps;

/// <summary>
/// Indicative quotes from a cached XML rate pair: pair → <see cref="SwapQuote"/> with
/// min/max checks on both the pay-in and invoice side, plus the payer-facing message for
/// each availability reason. Nothing here throws — an unquotable pair is an unavailable
/// quote. <c>/create</c> stays the binding rate.
/// </summary>
public static class FixedFloatQuote
{
    public static SwapQuote QuoteFromRatePair(FixedFloatRatePair? pair, string payInAsset, long invoiceAmountMsats, string provider)
    {
        if (pair is null)
        {
            return Unavailable(payInAsset, provider, "pair_temporarily_unavailable", null);
        }
        var limits = FixedFloatRates.InvoiceLimitsFromRate(pair);
        var payAmount = FixedFloatRates.QuotePayAmountFromRate(pair, invoiceAmountMsats);
        if (payAmount is null)
        {
            return Unavailable(payInAsset, provider, "pair_temporarily_unavailable", limits);
        }
        // Prefer invoice-side limits when conversion succeeded; also compare the
        // indicative pay amount to XML min/max so padded <out> decimals (or any
        // future conversion miss) cannot leave a below-min asset selectable.
        var payBelowMin = FixedFloatRates.CompareDecimalAmounts(payAmount, limits.MinimumPayAmount) == -1;
        var payAboveMax = FixedFloatRates.CompareDecimalAmounts(payAmount, limits.MaximumPayAmount) == 1;
        var amountTooSmall = payBelowMin ||
                             (limits.MinimumInvoiceAmountMsats is { } minimum && invoiceAmountMsats < minimum);
        var amountTooLarge = payAboveMax ||
                             (limits.MaximumInvoiceAmountMsats is { } maximum && invoiceAmountMsats > maximum);
        if (amountTooSmall || amountTooLarge)
        {
            return Unavailable(payInAsset, provider, amountTooSmall ? "amount_too_small" : "amount_too_large", limits);
        }
        return new SwapQuote
        {
            PayAmount = payAmount,
            PayAsset = payInAsset,
            Available = true,
            Provider = provider,
            MinimumPayAmount = limits.MinimumPayAmount,
            MaximumPayAmount = limits.MaximumPayAmount,
            MinimumInvoiceAmountMsats = limits.MinimumInvoiceAmountMsats,
            MaximumInvoiceAmountMsats = limits.MaximumInvoiceAmountMsats,
        };
    }

    public static string AvailabilityMessage(string reason) => reason switch
    {
        "amount_too_small" => "This invoice is below the provider minimum.",
        "amount_too_large" => "This invoice is above the provider maximum.",
        "provider_rate_limited" => "The swap provider is rate limited.",
        "provider_unreachable" => "The swap provider is temporarily unreachable.",
        _ => "This payment route is temporarily unavailable.",
    };

    private static SwapQuote Unavailable(string payInAsset, string provider, string reason, FixedFloatInvoiceLimits? limits) =>
        new()
        {
            PayAsset = payInAsset,
            Available = false,
            UnavailableReason = reason,
            UnavailableMessage = AvailabilityMessage(reason),
            Provider = provider,
            MinimumPayAmount = limits?.MinimumPayAmount,
            MaximumPayAmount = limits?.MaximumPayAmount,
            MinimumInvoiceAmountMsats = limits?.MinimumInvoiceAmountMsats,
            MaximumInvoiceAmountMsats = limits?.MaximumInvoiceAmountMsats,
        };
}
