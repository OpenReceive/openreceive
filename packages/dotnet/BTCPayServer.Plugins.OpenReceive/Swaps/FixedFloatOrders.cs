#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using BTCPayServer.Plugins.OpenReceive.Generated;

namespace BTCPayServer.Plugins.OpenReceive.Swaps;

/// <summary>A FixedFloat status, normalized: the OpenReceive state plus optional attention/refund reasons.</summary>
public sealed record FixedFloatStatus(string State, bool? Attention, string? AttentionReason, string? RefundReason);

/// <summary>
/// FixedFloat order bodies (<c>/create</c>, <c>/order</c>) → <see cref="SwapOrder"/>:
/// provider status → OpenReceive state (including the EMERGENCY refund/attention
/// branches), field-by-field fallback to the order already persisted, and the USD fee pair.
/// </summary>
public static class FixedFloatOrders
{
    /// <summary>
    /// Shape a FixedFloat order body into the SwapOrder we persist as swap_data. The
    /// fresh response wins field by field; <paramref name="fallback"/> is the order
    /// already persisted when this is a poll rather than a create.
    /// </summary>
    public static SwapOrder NormalizeOrder(JsonNode? data, string provider, string payInAsset, SwapOrder? fallback = null)
    {
        var record = FixedFloatFields.ObjectOrEmpty(data);
        var from = FixedFloatFields.ObjectOrEmpty(record["from"]);
        var emergency = record["emergency"] as JsonObject;
        var refundTxId = FixedFloatFields.OptionalNestedString(record, "back", "tx", "id")
                         ?? FixedFloatFields.OptionalNestedString(record, "refund", "tx", "id")
                         ?? fallback?.RefundTxId;
        var rawStatus = FixedFloatFields.OptionalStringField(record, "status");
        // A thin poll body with no `status` keeps the state we already persisted
        // VERBATIM: fallback.State is an OpenReceive state, and NormalizeStatus only
        // speaks FixedFloat statuses — it would map "awaiting_deposit" to attention.
        var status = rawStatus is null && fallback is not null
            ? new FixedFloatStatus(fallback.State, fallback.Attention, fallback.AttentionReason, fallback.RefundReason)
            : NormalizeStatus(rawStatus ?? "NEW", emergency, refundTxId);

        return new SwapOrder
        {
            Provider = provider,
            ProviderOrderId = RequiredOrderField(record, "id", fallback?.ProviderOrderId, "id"),
            ProviderToken = RequiredOrderField(record, "token", fallback?.ProviderToken, "token"),
            PayInAsset = payInAsset,
            DepositAddress = RequiredOrderField(from, "address", fallback?.DepositAddress, "from.address"),
            DepositMemo = FixedFloatFields.OptionalStringField(from, "tag") ?? fallback?.DepositMemo,
            DepositAmount = RequiredOrderField(from, "amount", fallback?.DepositAmount, "from.amount"),
            // No invented deadline: the provider states the expiry, and on a thin poll
            // body the one we already persisted stands.
            ExpiresAt = FixedFloatFields.ReadUnixSeconds(FixedFloatFields.ObjectOrEmpty(record["time"])["expiration"])
                        ?? fallback?.ExpiresAt
                        ?? throw new InvalidOperationException("FixedFloat order is missing time.expiration."),
            State = status.State,
            DepositTxId = FixedFloatFields.OptionalNestedString(record, "from", "tx", "id") ?? fallback?.DepositTxId,
            PayoutTxId = FixedFloatFields.OptionalNestedString(record, "to", "tx", "id") ?? fallback?.PayoutTxId,
            RefundTxId = refundTxId,
            Attention = status.Attention,
            AttentionReason = status.AttentionReason,
            RefundReason = status.RefundReason ?? (IsRefundPathState(status.State) ? fallback?.RefundReason : null),
            DepositReceivedAmount = FixedFloatFields.ReadDecimalAmountString(
                                        FixedFloatFields.OptionalNestedString(record, "from", "tx", "amount"), "from.tx.amount")
                                    ?? fallback?.DepositReceivedAmount,
            RefundAmount = FixedFloatFields.ReadDecimalAmountString(
                               FixedFloatFields.OptionalNestedString(record, "back", "amount"), "back.amount")
                           ?? fallback?.RefundAmount,
            EmergencyRepeat = ReadEmergencyRepeat(emergency) ?? fallback?.EmergencyRepeat,
            Fee = ReadOrderFee(record) ?? fallback?.Fee,
        };
    }

    /// <summary>
    /// FixedFloat reports the USD equivalents of both sides of the exchange; their gap is
    /// the swap fee the payer absorbs, so we surface both to explain the price.
    /// </summary>
    public static SwapFee? ReadOrderFee(JsonObject record)
    {
        var payInFiat = FixedFloatFields.OptionalNestedString(record, "from", "usd");
        var payoutFiat = FixedFloatFields.OptionalNestedString(record, "to", "usd");
        if (payInFiat is null || payoutFiat is null) return null;
        return new SwapFee("USD", payInFiat, payoutFiat);
    }

    /// <summary>
    /// FixedFloat status + emergency block + refund-tx presence → OpenReceive state and
    /// reasons: an interpreter of spec/data/swap-state-table.json (rendered into
    /// <see cref="OpenReceiveTables.SwapStatusRows"/>), first-match-wins. Pinned across
    /// engines by spec/test-vectors/swap-state.json; how to read the rows lives in the
    /// JSON. The validator asserts the table ends in a catch-all row.
    /// </summary>
    public static FixedFloatStatus NormalizeStatus(string status, JsonObject? emergency, string? refundTxId)
    {
        var normalized = status.ToUpperInvariant();
        var refundTxPresent = refundTxId is not null;
        var choice = FixedFloatFields.OptionalStringField(emergency, "choice")?.ToUpperInvariant();
        var row = OpenReceiveTables.SwapStatusRows.First(candidate =>
            (candidate.Status == "*"
                ? candidate.StatusContains is null || normalized.Contains(candidate.StatusContains, StringComparison.Ordinal)
                : candidate.Status == normalized)
            && (candidate.RefundTxPresent is null || candidate.RefundTxPresent == refundTxPresent)
            && (candidate.Choice == "any" || (choice is null ? candidate.Choice == "absent" : candidate.Choice == choice)));
        var refundReason = row.RefundReasonFromEmergency
            ? RefundReasonFromEmergencyStatuses(FixedFloatFields.OptionalStringArrayField(emergency, "status"))
            : null;
        return new FixedFloatStatus(row.State, row.AttentionReason is null ? null : true, row.AttentionReason, refundReason);
    }

    private static string RequiredOrderField(JsonObject record, string field, string? fallback, string label) =>
        FixedFloatFields.OptionalStringField(record, field) ?? fallback ?? FixedFloatFields.RequiredString(record[field], label);

    private static string? RefundReasonFromEmergencyStatuses(IReadOnlyList<string> statuses)
    {
        var present = statuses
            .Select(item => item.ToUpperInvariant())
            .Select(item => OpenReceiveTables.SwapEmergencyStatusAliases.TryGetValue(item, out var canonical) ? canonical : item)
            .ToHashSet(StringComparer.Ordinal);
        return OpenReceiveTables.SwapRefundReasonRows
            .FirstOrDefault(row => row.AllOf.All(present.Contains))
            ?.RefundReason;
    }

    private static bool IsRefundPathState(string state) =>
        state is "refund_required" or "refund_pending" or "refunded";

    private static bool? ReadEmergencyRepeat(JsonObject? emergency)
    {
        if (emergency is null) return null;
        if (emergency["repeat"] is not JsonValue value) return null;
        if (value.TryGetValue<bool>(out var flag)) return flag;
        if (value.TryGetValue<JsonElement>(out var element))
        {
            switch (element.ValueKind)
            {
                case JsonValueKind.True: return true;
                case JsonValueKind.False: return false;
                case JsonValueKind.Number:
                    if (element.TryGetInt64(out var number)) return number switch { 0 => false, 1 => true, _ => null };
                    return null;
                case JsonValueKind.String:
                    return element.GetString() switch { "0" => false, "1" => true, _ => null };
                default:
                    return null;
            }
        }
        var text = FixedFloatFields.OptionalCoercedString(value);
        return text switch { "0" => false, "1" => true, _ => null };
    }
}
