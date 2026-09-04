#nullable enable
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace BTCPayServer.Plugins.OpenReceive.Swaps;

/// <summary>
/// Scalar readers for FixedFloat's loosely typed JSON: strings that may arrive as
/// numbers, optional nested paths, string-or-array fields, unix-seconds timestamps,
/// and plain decimal amounts. Every FixedFloat response reader builds on these.
/// </summary>
internal static partial class FixedFloatFields
{
    [GeneratedRegex(@"^[0-9]+(\.[0-9]+)?$")]
    private static partial Regex DecimalAmountPattern();

    /// <summary>The node as an object, or an empty object for anything else (JS <c>recordOrEmpty</c>).</summary>
    public static JsonObject ObjectOrEmpty(JsonNode? node) => node as JsonObject ?? new JsonObject();

    /// <summary>A non-empty string, or a finite number rendered as text; null for anything else.</summary>
    public static string? OptionalCoercedString(JsonNode? node)
    {
        if (node is not JsonValue value) return null;
        if (value.TryGetValue<string>(out var text)) return text.Length > 0 ? text : null;
        if (value.TryGetValue<JsonElement>(out var element))
        {
            if (element.ValueKind == JsonValueKind.String)
            {
                var elementText = element.GetString() ?? string.Empty;
                return elementText.Length > 0 ? elementText : null;
            }
            if (element.ValueKind != JsonValueKind.Number) return null;
            if (element.TryGetInt64(out var integer)) return integer.ToString(CultureInfo.InvariantCulture);
            if (element.TryGetDecimal(out var exact)) return exact.ToString(CultureInfo.InvariantCulture);
            if (element.TryGetDouble(out var real) && double.IsFinite(real)) return PlainDecimal(real);
            return null;
        }
        if (value.TryGetValue<long>(out var l)) return l.ToString(CultureInfo.InvariantCulture);
        if (value.TryGetValue<int>(out var i)) return i.ToString(CultureInfo.InvariantCulture);
        if (value.TryGetValue<decimal>(out var d)) return d.ToString(CultureInfo.InvariantCulture);
        if (value.TryGetValue<double>(out var real2) && double.IsFinite(real2)) return PlainDecimal(real2);
        return null;
    }

    /// <summary>
    /// A JSON number as plain decimal text, never exponent notation: "R" renders 0.00000001
    /// as 1E-08, which is not an amount downstream (the decimal-amount check, the wei
    /// conversion). Decimal is exact for every amount a provider quotes; the double path is
    /// the fallback for a magnitude decimal cannot hold.
    /// </summary>
    private static string PlainDecimal(double real) => real.ToString("0.############################", CultureInfo.InvariantCulture);

    public static string? OptionalStringField(JsonObject? record, string field) =>
        record is null ? null : OptionalCoercedString(record[field]);

    public static string? OptionalNestedString(JsonNode? node, params string[] path)
    {
        var current = node;
        foreach (var key in path)
        {
            current = ObjectOrEmpty(current)[key];
        }
        return OptionalCoercedString(current);
    }

    public static IReadOnlyList<string> OptionalStringArrayField(JsonObject? record, string field)
    {
        if (record is null) return Array.Empty<string>();
        var value = record[field];
        if (value is JsonArray array)
        {
            var items = new List<string>(array.Count);
            foreach (var item in array)
            {
                var text = OptionalCoercedString(item);
                if (text is not null) items.Add(text);
            }
            return items;
        }
        var single = OptionalCoercedString(value);
        return single is null ? Array.Empty<string>() : new[] { single };
    }

    public static string RequiredString(JsonNode? node, string field) =>
        OptionalCoercedString(node) ?? throw new InvalidOperationException($"FixedFloat response missing {field}.");

    public static bool? OptionalBoolean(JsonObject? record, string field)
    {
        if (record?[field] is not JsonValue value) return null;
        if (value.TryGetValue<bool>(out var flag)) return flag;
        if (value.TryGetValue<JsonElement>(out var element))
        {
            if (element.ValueKind == JsonValueKind.True) return true;
            if (element.ValueKind == JsonValueKind.False) return false;
        }
        return null;
    }

    /// <summary>A non-negative integer unix timestamp, from a number or a numeric string.</summary>
    public static long? ReadUnixSeconds(JsonNode? node)
    {
        if (node is not JsonValue value) return null;
        string? text = null;
        if (value.TryGetValue<string>(out var s))
        {
            text = s;
        }
        else if (value.TryGetValue<JsonElement>(out var element))
        {
            if (element.ValueKind == JsonValueKind.String) text = element.GetString();
            else if (element.ValueKind == JsonValueKind.Number) text = element.GetRawText();
            else return null;
        }
        else
        {
            text = OptionalCoercedString(node);
        }
        if (text is null) return null;
        if (long.TryParse(text.Trim(), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var integer))
        {
            return integer >= 0 && integer <= 9007199254740991 ? integer : null;
        }
        if (double.TryParse(text.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var real) &&
            double.IsFinite(real) && Math.Floor(real) == real && real >= 0 && real <= 9007199254740991)
        {
            return (long)real;
        }
        return null;
    }

    /// <summary>
    /// A provider-reported decimal amount. Absent means absent; present-but-unparsable is a
    /// provider contract break and throws rather than silently dropping the amount.
    /// </summary>
    public static string? ReadDecimalAmountString(string? value, string label)
    {
        if (value is null) return null;
        if (!DecimalAmountPattern().IsMatch(value))
        {
            throw new InvalidOperationException($"FixedFloat {label} is not a decimal amount.");
        }
        return value;
    }
}
