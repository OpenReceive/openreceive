#nullable enable
using System;
using System.Globalization;
using System.Numerics;
using System.Text.RegularExpressions;

namespace BTCPayServer.Plugins.OpenReceive.Swaps;

/// <summary>A non-negative decimal as integer units at a scale: <c>1.25</c> is (125, 2).</summary>
internal readonly record struct DecimalUnits(BigInteger Units, int Scale);

/// <summary>
/// Exact integer/decimal money math — the C# rendering of the JS
/// <c>@openreceive/core</c> decimal engine. BigInteger only, never binary floats.
/// </summary>
internal static partial class DecimalMath
{
    public static readonly BigInteger SatsPerBtc = new(100_000_000);
    public static readonly BigInteger MsatsPerSat = new(1000);

    [GeneratedRegex(@"^\d+(?:\.\d+)?$")]
    private static partial Regex DecimalPattern();

    /// <summary>Parse a non-negative decimal string; throws <see cref="FormatException"/> otherwise.</summary>
    public static DecimalUnits ParseDecimal(string value, string fieldName = "Amount")
    {
        if (!DecimalPattern().IsMatch(value))
        {
            throw new FormatException($"{fieldName} must be a non-negative decimal string.");
        }
        var dot = value.IndexOf('.');
        var integer = dot < 0 ? value : value[..dot];
        var fraction = dot < 0 ? string.Empty : value[(dot + 1)..];
        return new DecimalUnits(BigInteger.Parse(integer + fraction, CultureInfo.InvariantCulture), fraction.Length);
    }

    /// <summary><c>10^scale</c> as a BigInteger.</summary>
    public static BigInteger ScaleFactor(int scale)
    {
        if (scale < 0) throw new ArgumentOutOfRangeException(nameof(scale), "Decimal scale must be a non-negative integer.");
        return BigInteger.Pow(10, scale);
    }

    /// <summary>Format integer units at a fixed scale back to a decimal string.</summary>
    public static string FormatDecimal(BigInteger units, int scale)
    {
        if (scale < 0) throw new ArgumentOutOfRangeException(nameof(scale), "Decimal scale must be a non-negative integer.");
        if (scale == 0) return units.ToString(CultureInfo.InvariantCulture);
        var negative = units.Sign < 0;
        var digits = BigInteger.Abs(units).ToString(CultureInfo.InvariantCulture).PadLeft(scale + 1, '0');
        var whole = digits[..^scale];
        var fraction = digits[^scale..];
        return $"{(negative ? "-" : string.Empty)}{whole}.{fraction}";
    }

    /// <summary>Ceiling division for a non-negative numerator: rounds UP on any remainder.</summary>
    public static BigInteger CeilDiv(BigInteger numerator, BigInteger denominator)
    {
        if (denominator.Sign <= 0) throw new ArgumentOutOfRangeException(nameof(denominator), "Division denominator must be greater than zero.");
        return (numerator + denominator - 1) / denominator;
    }
}
