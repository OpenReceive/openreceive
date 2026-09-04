#nullable enable
using System;
using System.Collections.Generic;
using System.Numerics;
using System.Text.RegularExpressions;
using BTCPayServer.Plugins.OpenReceive.Generated;

namespace BTCPayServer.Plugins.OpenReceive.Swaps;

/// <summary>One pair from the FixedFloat public XML rates export.</summary>
/// <param name="In">Reference send amount in <paramref name="From"/> (defines the rate with <paramref name="Out"/>).</param>
/// <param name="Out">Reference receive amount in <paramref name="To"/>.</param>
/// <param name="Amount">Reserve availability hint for <paramref name="To"/> — not a max exchange amount.</param>
/// <param name="ToFee">Network fee on the <paramref name="To"/> side, excluded from <paramref name="Out"/> (e.g. "0.0005 BTC").</param>
public sealed record FixedFloatRatePair(
    string From,
    string To,
    string In,
    string Out,
    string Amount,
    string MinAmount,
    string MaxAmount,
    string? ToFee = null);

/// <summary>Pairs keyed as <c>FROM:TO</c> (uppercased), stamped with when they were fetched.</summary>
public sealed record FixedFloatRatesIndex(long FetchedAt, IReadOnlyDictionary<string, FixedFloatRatePair> Pairs);

/// <summary>Invoice-side limits derived from a pair's XML from-side min/max.</summary>
public sealed record FixedFloatInvoiceLimits(
    string MinimumPayAmount,
    string MaximumPayAmount,
    long? MinimumInvoiceAmountMsats,
    long? MaximumInvoiceAmountMsats);

/// <summary>
/// FixedFloat public XML rates export — the bulk feed for all pairs. No API key, no
/// weight budget. OpenReceive keeps only Lightning-payout pairs that match its small
/// pay-in asset list and derives indicative quotes / min-max locally. <c>/create</c>
/// remains authoritative.
/// </summary>
public static partial class FixedFloatRates
{
    /// <summary>Fraction digits the indicative pay-in amount is reported at.</summary>
    private const int PayAmountFractionDigits = 8;

    [GeneratedRegex(@"<item\b[^>]*>([\s\S]*?)</item>", RegexOptions.IgnoreCase)]
    private static partial Regex ItemPattern();

    [GeneratedRegex(@"^([0-9]+(?:\.[0-9]+)?)")]
    private static partial Regex LeadingDecimalPattern();

    [GeneratedRegex(@"^([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z]+)?$")]
    private static partial Regex ToFeePattern();

    public static string PairKey(string from, string to) => $"{from.Trim().ToUpperInvariant()}:{to.Trim().ToUpperInvariant()}";

    public static string RatesXmlPath(string rateType = "fixed") => $"/rates/{rateType}.xml";

    /// <summary>Keep only pairs whose <c>to</c> side is a Lightning BTC payout code.</summary>
    public static IReadOnlyDictionary<string, FixedFloatRatePair> RetainLightningPayoutPairs(IReadOnlyDictionary<string, FixedFloatRatePair> pairs)
    {
        var retained = new Dictionary<string, FixedFloatRatePair>(StringComparer.Ordinal);
        foreach (var (key, pair) in pairs)
        {
            if (SwapAssets.IsLightningNetwork(pair.To)) retained[key] = pair;
        }
        return retained;
    }

    /// <summary>Keep only the from→Lightning keys that match resolved OpenReceive pay-in currencies.</summary>
    public static FixedFloatRatesIndex RetainPairsForKeys(FixedFloatRatesIndex index, IReadOnlySet<string> pairKeys)
    {
        var pairs = new Dictionary<string, FixedFloatRatePair>(StringComparer.Ordinal);
        if (pairKeys.Count == 0) return new FixedFloatRatesIndex(index.FetchedAt, pairs);
        foreach (var key in pairKeys)
        {
            if (index.Pairs.TryGetValue(key, out var pair)) pairs[key] = pair;
        }
        return new FixedFloatRatesIndex(index.FetchedAt, pairs);
    }

    public static IReadOnlyDictionary<string, FixedFloatRatePair> ParseRatesXml(string xml)
    {
        var pairs = new Dictionary<string, FixedFloatRatePair>(StringComparer.Ordinal);
        foreach (Match item in ItemPattern().Matches(xml))
        {
            var itemXml = item.Groups[1].Value;
            var from = ReadTagText(itemXml, "from");
            var to = ReadTagText(itemXml, "to");
            var inAmount = ReadTagText(itemXml, "in");
            var outAmount = ReadTagText(itemXml, "out");
            var amount = ReadTagText(itemXml, "amount");
            var minamount = ReadTagText(itemXml, "minamount");
            var maxamount = ReadTagText(itemXml, "maxamount");
            if (from is null || to is null || inAmount is null || outAmount is null ||
                amount is null || minamount is null || maxamount is null)
            {
                continue;
            }
            var tofee = ReadTagText(itemXml, "tofee");
            var pair = new FixedFloatRatePair(
                from.Trim(),
                to.Trim(),
                StripCurrencySuffix(inAmount),
                StripCurrencySuffix(outAmount),
                StripCurrencySuffix(amount),
                StripCurrencySuffix(minamount),
                StripCurrencySuffix(maxamount),
                tofee?.Trim());
            pairs[PairKey(pair.From, pair.To)] = pair;
        }
        return pairs;
    }

    /// <summary>
    /// Indicative pay-in amount for a Lightning payout of <paramref name="invoiceAmountMsats"/>:
    /// pay_from = (invoice_btc + tofee_btc) × (in / out), rounded UP at 8 decimals so the UI
    /// never understates what <c>/create</c> is likely to require. Null when the pair is unquotable.
    /// </summary>
    public static string? QuotePayAmountFromRate(FixedFloatRatePair pair, long invoiceAmountMsats)
    {
        if (invoiceAmountMsats <= 0 || invoiceAmountMsats > OpenReceiveTables.MaxAmountMsats) return null;
        var rateIn = ParsePositiveDecimal(pair.In);
        var rateOut = ParsePositiveDecimal(pair.Out);
        if (rateIn is null || rateOut is null) return null;

        var invoiceSats = DecimalMath.CeilDiv(new BigInteger(invoiceAmountMsats), DecimalMath.MsatsPerSat);
        var tofeeSats = ParseToFeeBtcSats(pair.ToFee) ?? BigInteger.Zero;
        var totalSats = invoiceSats + tofeeSats;

        // pay_from = total_sats * in / (out * 1e8), computed as an 8-decimal fixed-point
        // integer of the from currency — never binary floats.
        var payAt8Dp = DecimalMath.CeilDiv(
            totalSats * rateIn.Value.Units * DecimalMath.ScaleFactor(rateOut.Value.Scale),
            DecimalMath.ScaleFactor(rateIn.Value.Scale) * rateOut.Value.Units);
        return FormatPayAmount(payAt8Dp, PayAmountFractionDigits, PayAmountFractionDigits);
    }

    /// <summary>
    /// Maps XML from-side min/max into invoice-side msats using the pair's reference rate.
    /// Minimum rounds up, maximum rounds down, so borderline invoices are never reported
    /// as inside a range the provider would reject.
    /// </summary>
    public static FixedFloatInvoiceLimits InvoiceLimitsFromRate(FixedFloatRatePair pair) =>
        new(
            pair.MinAmount,
            pair.MaxAmount,
            PayAmountToInvoiceMsats(pair, pair.MinAmount, roundUp: true),
            PayAmountToInvoiceMsats(pair, pair.MaxAmount, roundUp: false));

    /// <summary>
    /// Compare two positive decimal strings: negative when left &lt; right, zero when equal,
    /// positive when left &gt; right. Null when either is not a positive decimal.
    /// </summary>
    public static int? CompareDecimalAmounts(string left, string right)
    {
        var a = ParsePositiveDecimal(left);
        var b = ParsePositiveDecimal(right);
        if (a is null || b is null) return null;
        var leftScaled = a.Value.Units * DecimalMath.ScaleFactor(b.Value.Scale);
        var rightScaled = b.Value.Units * DecimalMath.ScaleFactor(a.Value.Scale);
        return leftScaled.CompareTo(rightScaled) switch
        {
            < 0 => -1,
            > 0 => 1,
            _ => 0,
        };
    }

    /// <summary>Inverse of the direction=to quote (ignoring tofee): invoice_sats = pay_from × out × 1e8 / in.</summary>
    private static long? PayAmountToInvoiceMsats(FixedFloatRatePair pair, string payAmount, bool roundUp)
    {
        var pay = ParsePositiveDecimal(payAmount);
        var rateIn = ParsePositiveDecimal(pair.In);
        var rateOut = ParsePositiveDecimal(pair.Out);
        if (pay is null || rateIn is null || rateOut is null) return null;

        var numerator = pay.Value.Units * rateOut.Value.Units * DecimalMath.SatsPerBtc * DecimalMath.ScaleFactor(rateIn.Value.Scale);
        var denominator = DecimalMath.ScaleFactor(pay.Value.Scale) * DecimalMath.ScaleFactor(rateOut.Value.Scale) * rateIn.Value.Units;
        if (denominator.Sign <= 0) return null;
        var invoiceSats = roundUp ? DecimalMath.CeilDiv(numerator, denominator) : numerator / denominator;
        if (invoiceSats.Sign <= 0) return null;
        var msats = invoiceSats * DecimalMath.MsatsPerSat;
        if (msats > new BigInteger(OpenReceiveTables.MaxAmountMsats)) return null;
        return (long)msats;
    }

    private static BigInteger? ParseToFeeBtcSats(string? tofee)
    {
        if (tofee is null) return null;
        // Examples: "0.0004967000 BTC", "0.0005 BTCLN". Non-BTC fees are ignored —
        // we always pay out Lightning BTC, so only BTC network fees fold into pay-in.
        var match = ToFeePattern().Match(tofee.Trim());
        if (!match.Success) return null;
        var amount = match.Groups[1].Value;
        var unit = (match.Groups[2].Success ? match.Groups[2].Value : "BTC").ToUpperInvariant();
        if (unit != "BTC" && unit != "BTCLN") return null;
        var parsed = ParsePositiveDecimal(amount);
        if (parsed is null) return null;
        // Fees carrying more than 8 decimals are reduced to whole sats with ceil rounding.
        return DecimalMath.CeilDiv(parsed.Value.Units * DecimalMath.SatsPerBtc, DecimalMath.ScaleFactor(parsed.Value.Scale));
    }

    /// <summary>Provider-data decimal parse: an unusable value is "cannot quote" (null), never a throw.</summary>
    private static DecimalUnits? ParsePositiveDecimal(string value)
    {
        DecimalUnits parsed;
        try
        {
            parsed = DecimalMath.ParseDecimal(value);
        }
        catch (FormatException)
        {
            return null;
        }
        return parsed.Units.Sign > 0 ? parsed : null;
    }

    /// <summary>
    /// Render fixed-point units at scale with at most maxFractionDigits, rounding any
    /// discarded remainder up, and trimming trailing zeros.
    /// </summary>
    private static string FormatPayAmount(BigInteger units, int scale, int maxFractionDigits)
    {
        var target = DecimalMath.ScaleFactor(maxFractionDigits);
        var current = DecimalMath.ScaleFactor(scale);
        var rescaled = scale <= maxFractionDigits ? units * (target / current) : DecimalMath.CeilDiv(units * target, current);
        var text = DecimalMath.FormatDecimal(rescaled, maxFractionDigits);
        return text.Contains('.') ? text.TrimEnd('0').TrimEnd('.') : text;
    }

    private static string StripCurrencySuffix(string value)
    {
        var trimmed = value.Trim();
        var match = LeadingDecimalPattern().Match(trimmed);
        return match.Success ? match.Groups[1].Value : trimmed;
    }

    private static string? ReadTagText(string xml, string tag)
    {
        var match = Regex.Match(xml, $@"<{tag}\b[^>]*>([\s\S]*?)</{tag}>", RegexOptions.IgnoreCase);
        if (!match.Success) return null;
        var text = match.Groups[1].Value.Trim();
        return text.Length == 0 ? null : text;
    }
}
